'use strict';
/*
 * 版本对比 HTTP API 端到端测试：node tests/comparisons.test.js
 * 覆盖：
 *  - 发起校验：缺参/相同版本/倒序/不存在版本/跨图纸访问均明确拒绝，不留任务
 *  - 相同编号仅作建议：创建后 pairs 为空，建议含同编号（含复用编号），不含改名/新增编号
 *  - 保存配对草稿：缺版本/版本冲突/未知编号/重复占用均拒绝且不留下部分配对；
 *    合法保存推进版本；相同内容幂等（changed=false，版本不前进）
 *  - 乐观锁：他人先保存后，旧版本提交 → 409 并附最新配对状态，被拒内容不生效
 *  - 完成：生成只读差异结果（逐对编号/风险等级/顶点变化 + 两侧未配对区域）；
 *    完成后改配对/再完成均 409；后续编辑与再发布不改变已冻结结果
 *
 * 使用独立临时 DATA_DIR，在进程内启动真实 Express 服务。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'hpa-cmp-test-'));
process.env.DATA_DIR = tmpData;
process.env.PORT = String(8600 + Math.floor(Math.random() * 200));
process.env.HOST = '127.0.0.1';

const config = require('../server/config');
const app = require('../server/app'); // 启动监听
const server = app.server;

const base = `http://127.0.0.1:${config.port}`;
let n = 0;
async function check(name, fn) {
  await fn();
  n++;
  console.log('  ✓', name);
}

async function jfetch(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* 无 JSON */ }
  return { status: res.status, data, res };
}

/* ----------------------- 生成合法 PNG（可通过服务端损坏检测） ----------------------- */

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n2 = 0; n2 < 256; n2++) {
    let c = n2;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n2] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(w, h, gray = 200) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w, gray)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

async function createPlan(png, name) {
  const fd = new FormData();
  fd.append('image', new Blob([png], { type: 'image/png' }), 'plan.png');
  fd.append('name', name);
  const res = await fetch(base + '/api/plans', { method: 'POST', body: fd });
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  return data;
}
async function addRegion(planId, code, risk, verts, planVersion) {
  const r = await jfetch('POST', `/api/plans/${planId}/regions`, {
    code, risk_level: risk, vertices: verts, plan_version: planVersion,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
const square = (x, y, s) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];

/* -------------------------------- 测试主体 -------------------------------- */

async function run() {
  // 另一张图纸：用于跨图纸访问校验（同样发两个巡检版）
  const otherPlan = (await createPlan(makePng(120, 120, 220), '对照馆')).plan.id;
  const op1 = await jfetch('POST', `/api/plans/${otherPlan}/publications`, { plan_version: 1 });
  assert.equal(op1.status, 201);
  const op2 = await jfetch('POST', `/api/plans/${otherPlan}/publications`, { plan_version: 1 });
  assert.equal(op2.data.reused, true); // 同版本幂等，对照馆只有 1 个巡检版

  // 主图纸：三个区域后发布 #1
  const planId = (await createPlan(makePng(300, 200, 200), '对比测试馆')).plan.id;
  const a = await addRegion(planId, 'A-01', '低风险', square(10, 10, 40), 1);
  const b = await addRegion(planId, 'B-02', '高风险', square(80, 80, 40), a.plan_version);
  const c = await addRegion(planId, 'C-03', '中风险', square(150, 10, 40), b.plan_version);
  const regionA = a.region.id;
  const regionB = b.region.id;
  const regionC = c.region.id;
  const pub1 = await jfetch('POST', `/api/plans/${planId}/publications`, { plan_version: c.plan_version });
  assert.equal(pub1.status, 201);
  assert.equal(pub1.data.publication.seq, 1);

  // 发布 #1 后的编辑：A-01 升风险+移动一个顶点；B-02 删除后复用编号重建；
  // C-03 改名为 C-03R；新增 D-04。然后发布 #2
  const mvA = [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 55 }, { x: 10, y: 50 }];
  const upA = await jfetch('PUT', `/api/plans/${planId}/regions/${regionA}`, {
    code: 'A-01', risk_level: '中风险', vertices: mvA, version: 1, plan_version: c.plan_version,
  });
  assert.equal(upA.status, 200, JSON.stringify(upA.data));
  const delB = await jfetch('DELETE',
    `/api/plans/${planId}/regions/${regionB}?version=1&plan_version=${upA.data.plan_version}`);
  assert.equal(delB.status, 200, JSON.stringify(delB.data));
  const reB = await addRegion(planId, 'B-02', '低风险', square(200, 100, 40), delB.data.plan_version);
  const upC = await jfetch('PUT', `/api/plans/${planId}/regions/${regionC}`, {
    code: 'C-03R', risk_level: '中风险', vertices: square(150, 10, 40),
    version: 1, plan_version: reB.plan_version,
  });
  assert.equal(upC.status, 200, JSON.stringify(upC.data));
  const d = await addRegion(planId, 'D-04', '低风险', square(150, 100, 40), upC.data.plan_version);
  const pub2 = await jfetch('POST', `/api/plans/${planId}/publications`, { plan_version: d.plan_version });
  assert.equal(pub2.status, 201);
  assert.equal(pub2.data.publication.seq, 2);

  await check('发起校验：缺参 / 相同版本 / 倒序 / 不存在版本均拒绝，且不创建任务', async () => {
    const noParam = await jfetch('POST', `/api/plans/${planId}/comparisons`, {});
    assert.equal(noParam.status, 400);
    assert.equal(noParam.data.error, 'VALIDATION_ERROR');
    const same = await jfetch('POST', `/api/plans/${planId}/comparisons`, { old_seq: 2, new_seq: 2 });
    assert.equal(same.status, 400);
    assert.equal(same.data.error, 'INVALID_VERSION_ORDER');
    const reversed = await jfetch('POST', `/api/plans/${planId}/comparisons`, { old_seq: 2, new_seq: 1 });
    assert.equal(reversed.status, 400);
    assert.equal(reversed.data.error, 'INVALID_VERSION_ORDER');
    const missing = await jfetch('POST', `/api/plans/${planId}/comparisons`, { old_seq: 1, new_seq: 99 });
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error, 'NO_PUBLICATION');
    const list = await jfetch('GET', `/api/plans/${planId}/comparisons`);
    assert.equal(list.data.count, 0, '被拒绝的发起不能留下任何任务');
  });

  let cmpId = null;
  await check('发起成功 → 201：pairs 为空，相同编号仅作建议（含复用编号 B-02），改名/新增不建议', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/comparisons`,
      { old_seq: 1, new_seq: 2, creator: '王五' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.comparison.seq, 1);
    assert.equal(r.data.comparison.status, 'draft');
    assert.equal(r.data.comparison.version, 1);
    assert.equal(r.data.comparison.old_seq, 1);
    assert.equal(r.data.comparison.new_seq, 2);
    assert.equal(r.data.comparison.creator, '王五');
    assert.deepEqual(r.data.pairs, [], '相同编号不能自动进入配对');
    const sug = r.data.suggestions.map((s) => s.old_code).sort();
    assert.deepEqual(sug, ['A-01', 'B-02'], '建议只含两侧同编号（含被复用的 B-02）');
    assert.equal(r.data.old_regions.length, 3);
    assert.equal(r.data.new_regions.length, 4);
    assert.equal(r.data.old_publication.seq, 1);
    assert.equal(r.data.new_publication.seq, 2);
    cmpId = r.data.comparison.id;
  });

  await check('跨图纸访问任务 / 用本图纸不存在的序号发起 → 明确拒绝', async () => {
    const cross = await jfetch('GET', `/api/plans/${otherPlan}/comparisons/${cmpId}`);
    assert.equal(cross.status, 404);
    assert.equal(cross.data.error, 'COMPARISON_NOT_FOUND');
    const crossWrite = await jfetch('PUT', `/api/plans/${otherPlan}/comparisons/${cmpId}/pairs`,
      { version: 1, pairs: [] });
    assert.equal(crossWrite.status, 404);
    assert.equal(crossWrite.data.error, 'COMPARISON_NOT_FOUND');
    // 对照馆只有第 1 号巡检版，用第 2 号发起 → 不存在
    const noPub = await jfetch('POST', `/api/plans/${otherPlan}/comparisons`, { old_seq: 1, new_seq: 2 });
    assert.equal(noPub.status, 404);
    assert.equal(noPub.data.error, 'NO_PUBLICATION');
  });

  await check('保存草稿校验：缺版本 / 版本不符（409 附最新状态）/ pairs 非数组', async () => {
    const noVer = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`,
      { pairs: [] });
    assert.equal(noVer.status, 400);
    const stale = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`,
      { version: 99, pairs: [] });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'COMPARISON_VERSION_CONFLICT');
    assert.equal(stale.data.server.comparison.version, 1);
    assert.deepEqual(stale.data.server.pairs, []);
    const badShape = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`,
      { version: 1, pairs: 'A-01' });
    assert.equal(badShape.status, 400);
  });

  await check('未知编号 / 重复占用均 400 且不留下部分配对', async () => {
    const unknownOld = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`,
      { version: 1, pairs: [{ old_code: 'Z-99', new_code: 'A-01' }] });
    assert.equal(unknownOld.status, 400);
    assert.equal(unknownOld.data.error, 'UNKNOWN_REGION');
    const unknownNew = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`,
      { version: 1, pairs: [{ old_code: 'A-01', new_code: 'C-03' }] }); // C-03 已改名，新版中不存在
    assert.equal(unknownNew.status, 400);
    assert.equal(unknownNew.data.error, 'UNKNOWN_REGION');
    const dupOld = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`,
      { version: 1, pairs: [{ old_code: 'A-01', new_code: 'A-01' }, { old_code: 'A-01', new_code: 'B-02' }] });
    assert.equal(dupOld.status, 400);
    assert.equal(dupOld.data.error, 'PAIR_REGION_REUSED');
    const dupNew = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`,
      { version: 1, pairs: [{ old_code: 'A-01', new_code: 'B-02' }, { old_code: 'C-03', new_code: 'B-02' }] });
    assert.equal(dupNew.status, 400);
    assert.equal(dupNew.data.error, 'PAIR_REGION_REUSED');
    const detail = await jfetch('GET', `/api/plans/${planId}/comparisons/${cmpId}`);
    assert.deepEqual(detail.data.pairs, [], '失败的保存不能留下任何部分配对');
    assert.equal(detail.data.comparison.version, 1, '失败的保存不能推进版本');
  });

  await check('保存草稿（含手动改配改名区域 C-03→C-03R）→ 版本 1→2，建议随之减少', async () => {
    const r = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`, {
      version: 1,
      pairs: [{ old_code: 'A-01', new_code: 'A-01' }, { old_code: 'C-03', new_code: 'C-03R' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.changed, true);
    assert.equal(r.data.comparison.version, 2);
    assert.equal(r.data.comparison.pair_count, 2);
    assert.deepEqual(r.data.pairs, [
      { old_code: 'A-01', new_code: 'A-01' },
      { old_code: 'C-03', new_code: 'C-03R' },
    ]);
    assert.deepEqual(r.data.suggestions.map((s) => s.old_code), ['B-02']);
  });

  await check('相同内容重复保存幂等：changed=false，版本不前进', async () => {
    const r = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`, {
      version: 2,
      pairs: [{ old_code: 'C-03', new_code: 'C-03R' }, { old_code: 'A-01', new_code: 'A-01' }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.changed, false);
    assert.equal(r.data.comparison.version, 2);
  });

  await check('他人先保存后，旧版本提交 → 409 附最新配对状态，被拒内容不生效', async () => {
    // 「他人」基于 v2 加上 B-02↔B-02，版本推进到 3
    const other = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`, {
      version: 2,
      pairs: [
        { old_code: 'A-01', new_code: 'A-01' },
        { old_code: 'C-03', new_code: 'C-03R' },
        { old_code: 'B-02', new_code: 'B-02' },
      ],
    });
    assert.equal(other.status, 200);
    assert.equal(other.data.comparison.version, 3);
    // 「我」仍持 v2 提交 → 409，响应带服务端最新配对
    const stale = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`, {
      version: 2,
      pairs: [{ old_code: 'A-01', new_code: 'A-01' }],
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'COMPARISON_VERSION_CONFLICT');
    assert.equal(stale.data.server.comparison.version, 3);
    assert.equal(stale.data.server.pairs.length, 3);
    // 被拒内容未生效
    const detail = await jfetch('GET', `/api/plans/${planId}/comparisons/${cmpId}`);
    assert.equal(detail.data.pairs.length, 3);
    assert.equal(detail.data.comparison.version, 3);
  });

  await check('旧版本完成 → 409；当前版本完成 → 生成只读差异结果', async () => {
    const stale = await jfetch('POST', `/api/plans/${planId}/comparisons/${cmpId}/complete`,
      { version: 2 });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'COMPARISON_VERSION_CONFLICT');
    const ok = await jfetch('POST', `/api/plans/${planId}/comparisons/${cmpId}/complete`,
      { version: 3 });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.comparison.status, 'completed');
    assert.equal(ok.data.comparison.version, 4);
    assert.ok(ok.data.comparison.completed_at);

    const r = ok.data.result;
    assert.equal(r.old_seq, 1);
    assert.equal(r.new_seq, 2);
    assert.equal(r.pairs.length, 3);
    const pa = r.pairs.find((p) => p.old_code === 'A-01');
    assert.equal(pa.code_changed, false);
    assert.deepEqual(pa.risk_level, { old: '低风险', new: '中风险', changed: true });
    assert.equal(pa.vertices.changed, true);
    assert.equal(pa.vertices.old_count, 4);
    assert.equal(pa.vertices.new_count, 4);
    assert.equal(pa.vertices.moves.length, 1);
    assert.equal(pa.vertices.moves[0].index, 2);
    assert.deepEqual(pa.vertices.moves[0].from, { x: 50, y: 50 });
    assert.deepEqual(pa.vertices.moves[0].to, { x: 50, y: 55 });
    const pb = r.pairs.find((p) => p.old_code === 'B-02');
    assert.equal(pb.risk_level.changed, true);       // 高风险 → 低风险（编号复用也如实对比）
    assert.equal(pb.vertices.changed, true);
    assert.equal(pb.vertices.moves.length, 4);
    const pc = r.pairs.find((p) => p.old_code === 'C-03');
    assert.equal(pc.new_code, 'C-03R');
    assert.equal(pc.code_changed, true, '编号改名如实记录');
    assert.equal(pc.risk_level.changed, false);
    assert.equal(pc.vertices.changed, false);
    assert.deepEqual(r.unpaired_old, [], '旧版全部配对');
    assert.deepEqual(r.unpaired_new.map((x) => x.code), ['D-04']);
    assert.deepEqual(r.summary, {
      pair_count: 3, changed_pairs: 3, unchanged_pairs: 0,
      unpaired_old_count: 0, unpaired_new_count: 1,
    });
  });

  await check('完成后只读：改配对 / 再完成均 409 COMPARISON_COMPLETED', async () => {
    const edit = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`,
      { version: 4, pairs: [] });
    assert.equal(edit.status, 409);
    assert.equal(edit.data.error, 'COMPARISON_COMPLETED');
    assert.equal(edit.data.server.comparison.status, 'completed');
    const again = await jfetch('POST', `/api/plans/${planId}/comparisons/${cmpId}/complete`,
      { version: 4 });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'COMPARISON_COMPLETED');
  });

  let frozenResult = null;
  await check('冻结不变性：改名 + 区域编辑 + 发布 #3 后，已完成结果逐字节不变', async () => {
    const before = await jfetch('GET', `/api/plans/${planId}/comparisons/${cmpId}`);
    frozenResult = before.data.result;
    // 图纸改名
    const res = await fetch(base + `/api/plans/${planId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=' + encodeURIComponent('对比测试馆（新名）'),
    });
    assert.equal(res.status, 200);
    // 编辑区域 + 删除 D-04
    const planNow = await jfetch('GET', `/api/plans/${planId}`);
    const dRegion = planNow.data.regions.find((x) => x.code === 'D-04');
    const del = await jfetch('DELETE',
      `/api/plans/${planId}/regions/${dRegion.id}?version=${dRegion.version}&plan_version=${planNow.data.plan.version}`);
    assert.equal(del.status, 200);
    const pub3 = await jfetch('POST', `/api/plans/${planId}/publications`,
      { plan_version: del.data.plan_version });
    assert.equal(pub3.status, 201);
    assert.equal(pub3.data.publication.seq, 3);

    const after = await jfetch('GET', `/api/plans/${planId}/comparisons/${cmpId}`);
    assert.deepEqual(after.data.result, frozenResult, '差异结果不随编辑态或后续发布改变');
    assert.equal(after.data.comparison.plan_name, '对比测试馆', '任务保留创建时图纸名');
    assert.deepEqual(after.data.old_regions.map((x) => x.code), ['A-01', 'B-02', 'C-03']);
    // 冻结顺序 = 发布时区域 id 顺序（B-02 为删除后重建，排在 C-03R 之后）
    assert.deepEqual(after.data.new_regions.map((x) => x.code), ['A-01', 'C-03R', 'B-02', 'D-04']);
  });

  await check('列表含状态 / 配对数 / 两侧区域数；同一对版本可再建任务（序号递增）', async () => {
    const list = await jfetch('GET', `/api/plans/${planId}/comparisons`);
    assert.equal(list.status, 200);
    assert.equal(list.data.count, 1);
    const row = list.data.comparisons[0];
    assert.equal(row.status, 'completed');
    assert.equal(row.pair_count, 3);
    assert.equal(row.old_region_count, 3);
    assert.equal(row.new_region_count, 4);
    assert.equal(row.old_seq, 1);
    assert.equal(row.new_seq, 2);

    const second = await jfetch('POST', `/api/plans/${planId}/comparisons`,
      { old_seq: 1, new_seq: 2 });
    assert.equal(second.status, 201);
    assert.equal(second.data.comparison.seq, 2);
    // 空配对直接完成：全部区域进入两侧未配对清单
    const done = await jfetch('POST',
      `/api/plans/${planId}/comparisons/${second.data.comparison.id}/complete`, { version: 1 });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.deepEqual(done.data.result.pairs, []);
    assert.equal(done.data.result.summary.unpaired_old_count, 3);
    assert.equal(done.data.result.summary.unpaired_new_count, 4);
    assert.deepEqual(done.data.result.unpaired_new.map((x) => x.code),
      ['A-01', 'C-03R', 'B-02', 'D-04']);
  });

  await check('不存在 / 非法任务 id → 404 / 400', async () => {
    const miss = await jfetch('GET', `/api/plans/${planId}/comparisons/99999`);
    assert.equal(miss.status, 404);
    assert.equal(miss.data.error, 'COMPARISON_NOT_FOUND');
    const bad = await jfetch('GET', `/api/plans/${planId}/comparisons/abc`);
    assert.equal(bad.status, 400);
  });
}

run().then(() => {
  console.log(`\n版本对比 API 测试全部通过（${n} 项）`);
  server.close(() => {
    fs.rmSync(tmpData, { recursive: true, force: true });
    process.exit(0);
  });
}).catch((e) => {
  console.error('\n测试失败：', e);
  server.close(() => {
    try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch (_) {}
    process.exit(1);
  });
});
