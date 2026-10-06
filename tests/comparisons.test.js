'use strict';
/*
 * 区域沿革比对 HTTP API 端到端测试：node tests/comparisons.test.js
 * 覆盖：
 *  - 创建：跨图纸/不存在版本/倒序/相同版本/非法序号明确拒绝，不产生任务
 *  - 同编号仅为建议（suggestions），已确认配对初始为空
 *  - 保存草稿：乐观锁、全有/全无替换、重复占用 / 未知编号拒绝且不留部分配对
 *  - 冲突 409 附最新配对状态；完成后再写 COMPARISON_COMPLETED
 *  - 完成生成逐对差异（编号/风险等级/顶点变化 + 逐点位移）与两侧未配对清单
 *  - 完成后只读、结果冻结：随后编辑/再发布，差异结果不变
 *  - 列表 / 跨图纸访问 404 / 空配对也可完成（全部列入未配对）
 *
 * 使用独立临时 DATA_DIR，在进程内启动真实 Express 服务。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'hpa-comp-test-'));
process.env.DATA_DIR = tmpData;
process.env.PORT = String(8900 + Math.floor(Math.random() * 200));
process.env.HOST = '127.0.0.1';

const config = require('../server/config');
const app = require('../server/app');
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
  return { status: res.status, data };
}

/* ----------------------- 合法 PNG 生成 ----------------------- */

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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w, gray)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
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
async function publish(planId, planVersion) {
  const r = await jfetch('POST', `/api/plans/${planId}/publications`, { plan_version: planVersion });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.data));
  return r.data.publication;
}
const sq = (x, y, s) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];

/* -------------------------------- 测试主体 -------------------------------- */

async function run() {
  // 另一张图纸（仅 1 个发布版），用于跨图纸 / 单版本拒绝
  const other = await createPlan(makePng(200, 200, 205), '对照馆');
  const oa = await addRegion(other.plan.id, 'O-1', '低风险', sq(5, 5, 30), 1);
  await publish(other.plan.id, oa.plan_version);

  // 主图纸：#1 = A-01(低) + B-02(高) + C-03(中)
  const created = await createPlan(makePng(400, 300, 200), '沿革馆');
  const planId = created.plan.id;
  let v = (await addRegion(planId, 'A-01', '低风险', sq(10, 10, 40), 1)).plan_version;
  v = (await addRegion(planId, 'B-02', '高风险', sq(90, 10, 40), v)).plan_version;
  v = (await addRegion(planId, 'C-03', '中风险', sq(170, 10, 40), v)).plan_version;
  const pub1 = await publish(planId, v);
  assert.equal(pub1.seq, 1);

  // 编辑后发布 #2：A-01 顶点移动（同编号同等级）；B-02 改名 B-20 且等级降为中；
  // C-03 删除；新增 D-04
  // 区域 id 直接从详情按编号取，避免对自增序号做假设
  const detail1 = await jfetch('GET', `/api/plans/${planId}`);
  const byCode = Object.fromEntries(detail1.data.regions.map((r) => [r.code, r]));
  let cur = detail1.data.plan.version;
  let upd = await jfetch('PUT', `/api/plans/${planId}/regions/${byCode['A-01'].id}`, {
    code: 'A-01', risk_level: '低风险', vertices: sq(12, 12, 40),
    version: byCode['A-01'].version, plan_version: cur,
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  cur = upd.data.plan_version;
  upd = await jfetch('PUT', `/api/plans/${planId}/regions/${byCode['B-02'].id}`, {
    code: 'B-20', risk_level: '中风险', vertices: sq(90, 10, 40),
    version: byCode['B-02'].version, plan_version: cur,
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  cur = upd.data.plan_version;
  const del = await jfetch('DELETE',
    `/api/plans/${planId}/regions/${byCode['C-03'].id}?version=${byCode['C-03'].version}&plan_version=${cur}`);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  cur = del.data.plan_version;
  const addD = await addRegion(planId, 'D-04', '高风险', sq(250, 10, 40), cur);
  cur = addD.plan_version;
  const pub2 = await publish(planId, cur);
  assert.equal(pub2.seq, 2);

  // 再发布 #3：A-01 加一个顶点（顶点数变化）
  let d2 = await jfetch('GET', `/api/plans/${planId}`);
  const a2 = d2.data.regions.find((r) => r.code === 'A-01');
  const pentagon = [
    { x: 12, y: 12 }, { x: 52, y: 12 }, { x: 60, y: 32 }, { x: 52, y: 52 }, { x: 12, y: 52 },
  ];
  upd = await jfetch('PUT', `/api/plans/${planId}/regions/${a2.id}`, {
    code: 'A-01', risk_level: '低风险', vertices: pentagon,
    version: a2.version, plan_version: d2.data.plan.version,
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  const pub3 = await publish(planId, upd.data.plan_version);
  assert.equal(pub3.seq, 3);

  await check('只有一个发布版时引用第 2 版 → 404 NO_PUBLICATION，不产生任务', async () => {
    const r = await jfetch('POST', `/api/plans/${other.plan.id}/comparisons`, { older_seq: 1, newer_seq: 2 });
    assert.equal(r.status, 404);
    assert.equal(r.data.error, 'NO_PUBLICATION');
    const list = await jfetch('GET', `/api/plans/${other.plan.id}/comparisons`);
    assert.equal(list.data.count, 0);
  });

  await check('倒序 / 相同版本 / 非法序号 / 缺字段 均明确拒绝', async () => {
    const reversed = await jfetch('POST', `/api/plans/${planId}/comparisons`, { older_seq: 2, newer_seq: 1 });
    assert.equal(reversed.status, 400);
    assert.equal(reversed.data.error, 'REVERSED_ORDER');
    const same = await jfetch('POST', `/api/plans/${planId}/comparisons`, { older_seq: 2, newer_seq: 2 });
    assert.equal(same.status, 400);
    assert.equal(same.data.error, 'SAME_PUBLICATION');
    const bad = await jfetch('POST', `/api/plans/${planId}/comparisons`, { older_seq: 'latest', newer_seq: 2 });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, 'VALIDATION_ERROR');
    const missing = await jfetch('POST', `/api/plans/${planId}/comparisons`, { older_seq: 1 });
    assert.equal(missing.status, 400);
    const list = await jfetch('GET', `/api/plans/${planId}/comparisons`);
    assert.equal(list.data.count, 0);
  });

  await check('不存在的版本序号 → 404 NO_PUBLICATION 且不留任务', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/comparisons`, { older_seq: 1, newer_seq: 99 });
    assert.equal(r.status, 404);
    assert.equal(r.data.error, 'NO_PUBLICATION');
  });

  let cmpId = null;
  await check('创建 #1→#2 比对 → 201：两侧冻结区域齐全；同编号只作建议，配对初始为空', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/comparisons`, { older_seq: 1, newer_seq: 2, inspector: '李四' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    cmpId = r.data.comparison.id;
    assert.equal(r.data.comparison.status, 'in_progress');
    assert.equal(r.data.comparison.version, 1);
    assert.equal(r.data.comparison.older_region_count, 3);
    assert.equal(r.data.comparison.newer_region_count, 3);
    assert.deepEqual(r.data.older.regions.map((x) => x.code), ['A-01', 'B-02', 'C-03']);
    assert.deepEqual(r.data.newer.regions.map((x) => x.code), ['A-01', 'B-20', 'D-04']);
    // 仅 A-01 编号相同 → 一条建议；pairs 为空，绝不自动认定
    assert.deepEqual(r.data.suggestions, [{ old_code: 'A-01', new_code: 'A-01' }]);
    assert.deepEqual(r.data.pairs, []);
  });

  await check('跨图纸访问比对 → 404 COMPARISON_NOT_FOUND', async () => {
    const r = await jfetch('GET', `/api/plans/${other.plan.id}/comparisons/${cmpId}`);
    assert.equal(r.status, 404);
    assert.equal(r.data.error, 'COMPARISON_NOT_FOUND');
    const badId = await jfetch('GET', `/api/plans/${planId}/comparisons/abc`);
    assert.equal(badId.status, 400);
  });

  await check('保存草稿：确认 A-01 建议 + 手动改配 B-02→B-20（编号改名不自动认定）', async () => {
    const r = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`, {
      version: 1,
      pairs: [
        { old_code: 'A-01', new_code: 'A-01' },
        { old_code: 'B-02', new_code: 'B-20' },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.comparison.version, 2);
    assert.equal(r.data.comparison.pair_count, 2);
    // A-01 建议已被确认 → 建议列表清空
    assert.deepEqual(r.data.suggestions, []);
    // C-03（旧）与 D-04（新）未出现在任何配对中
  });

  await check('草稿全有/全无：未知编号 / 重复占用 → 400，旧配对保持不变', async () => {
    const unknown = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`, {
      version: 2,
      pairs: [
        { old_code: 'A-01', new_code: 'A-01' },
        { old_code: 'C-03', new_code: 'D-04' },
        { old_code: 'B-02', new_code: 'D-04' }, // D-04 被第二对占用
      ],
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.data.error, 'REGION_ALREADY_PAIRED');
    const ghost = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`, {
      version: 2,
      pairs: [{ old_code: 'A-01', new_code: 'Z-99' }],
    });
    assert.equal(ghost.status, 400);
    assert.equal(ghost.data.error, 'UNKNOWN_REGION');
    const detail = await jfetch('GET', `/api/plans/${planId}/comparisons/${cmpId}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.data.pairs, [
      { old_code: 'A-01', new_code: 'A-01' },
      { old_code: 'B-02', new_code: 'B-20' },
    ]);
  });

  await check('旧 version 保存 → 409 COMPARISON_VERSION_CONFLICT 附最新配对，提交不生效', async () => {
    const stale = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`, {
      version: 1,
      pairs: [{ old_code: 'A-01', new_code: 'A-01' }],
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'COMPARISON_VERSION_CONFLICT');
    assert.equal(stale.data.server.comparison.version, 2);
    assert.equal(stale.data.server.pairs.length, 2);
    // 未把被拒的单配对写入
    const detail = await jfetch('GET', `/api/plans/${planId}/comparisons/${cmpId}`);
    assert.equal(detail.data.pairs.length, 2);
  });

  await check('整份替换语义：保存空配对回到 0 对（版本继续推进）', async () => {
    const r = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`, {
      version: 2, pairs: [],
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.comparison.version, 3);
    assert.deepEqual(r.data.pairs, []);
    // 同编号建议重新出现
    assert.deepEqual(r.data.suggestions, [{ old_code: 'A-01', new_code: 'A-01' }]);
  });

  await check('完成前恢复两对；缺 version / 旧 version 完成被拒绝', async () => {
    const saved = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`, {
      version: 3,
      pairs: [
        { old_code: 'A-01', new_code: 'A-01' },
        { old_code: 'B-02', new_code: 'B-20' },
      ],
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.comparison.version, 4);
    const noVer = await jfetch('POST', `/api/plans/${planId}/comparisons/${cmpId}/complete`, {});
    assert.equal(noVer.status, 400);
    const stale = await jfetch('POST', `/api/plans/${planId}/comparisons/${cmpId}/complete`, { version: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'COMPARISON_VERSION_CONFLICT');
  });

  let result = null;
  await check('完成 → 201：逐对差异（编号/风险/顶点）与两侧未配对清单正确', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/comparisons/${cmpId}/complete`, { version: 4 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    result = r.data.result;
    assert.equal(result.older.seq, 1);
    assert.equal(result.newer.seq, 2);
    assert.equal(result.pair_count, 2);
    assert.equal(result.changed_pair_count, 2);
    const aPair = result.pairs.find((p) => p.old_code === 'A-01');
    assert.equal(aPair.code_changed, false);
    assert.equal(aPair.risk_level.changed, false);
    assert.equal(aPair.vertices.changed, true);
    assert.equal(aPair.vertices.summary, 'moved');
    assert.equal(aPair.vertices.old_count, 4);
    assert.equal(aPair.vertices.new_count, 4);
    assert.equal(aPair.vertices.moved_count, 4);
    const p1 = aPair.vertices.points[0];
    assert.deepEqual(p1.delta, { dx: 2, dy: 2 });
    assert.deepEqual(aPair.old_region.vertices[0], { x: 10, y: 10 });
    assert.deepEqual(aPair.new_region.vertices[0], { x: 12, y: 12 });

    const bPair = result.pairs.find((p) => p.old_code === 'B-02');
    assert.equal(bPair.new_code, 'B-20');
    assert.equal(bPair.code_changed, true);
    assert.deepEqual(bPair.changes.sort(), ['code', 'risk_level']);
    assert.equal(bPair.risk_level.old, '高风险');
    assert.equal(bPair.risk_level.new, '中风险');
    assert.equal(bPair.vertices.changed, false);

    assert.deepEqual(result.unpaired_old.codes, ['C-03']);
    assert.deepEqual(result.unpaired_new.codes, ['D-04']);
    assert.equal(result.unpaired_old.count, 1);
    assert.equal(result.unpaired_new.count, 1);
    assert.ok(result.completed_at);
  });

  await check('完成后只读：GET 返回 status=completed + result；再保存/再完成 409 COMPARISON_COMPLETED', async () => {
    const detail = await jfetch('GET', `/api/plans/${planId}/comparisons/${cmpId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.status, 'completed');
    assert.equal(detail.data.result.pair_count, 2);
    const save = await jfetch('PUT', `/api/plans/${planId}/comparisons/${cmpId}/pairs`, {
      version: 5, pairs: [],
    });
    assert.equal(save.status, 409);
    assert.equal(save.data.error, 'COMPARISON_COMPLETED');
    assert.equal(save.data.server.result.pair_count, 2);
    const again = await jfetch('POST', `/api/plans/${planId}/comparisons/${cmpId}/complete`, { version: 5 });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'COMPARISON_COMPLETED');
  });

  await check('结果冻结：再改名/编辑/发布 #4 后，已完成结果内容不变', async () => {
    await fetch(base + `/api/plans/${planId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=' + encodeURIComponent('改名后的沿革馆'),
    });
    const now = await jfetch('GET', `/api/plans/${planId}`);
    const aNow = now.data.regions.find((r) => r.code === 'A-01');
    const movedFar = await jfetch('PUT', `/api/plans/${planId}/regions/${aNow.id}`, {
      code: 'A-01', risk_level: '高风险', vertices: sq(200, 200, 40),
      version: aNow.version, plan_version: now.data.plan.version,
    });
    assert.equal(movedFar.status, 200, JSON.stringify(movedFar.data));
    await publish(planId, movedFar.data.plan_version); // #4

    const detail = await jfetch('GET', `/api/plans/${planId}/comparisons/${cmpId}`);
    const r = detail.data.result;
    assert.equal(r.plan_name, '沿革馆', '创建时图纸名冻结');
    assert.equal(r.older.seq, 1);
    assert.equal(r.newer.seq, 2);
    const aPair = r.pairs.find((p) => p.old_code === 'A-01');
    assert.equal(aPair.risk_level.old, '低风险');
    assert.equal(aPair.risk_level.new, '低风险');
    assert.deepEqual(aPair.new_region.vertices[0], { x: 12, y: 12 });
    assert.deepEqual(r.unpaired_old.codes, ['C-03']);
    assert.deepEqual(r.unpaired_new.codes, ['D-04']);
  });

  await check('列表含两版序号、配对数与状态（最新在前）', async () => {
    const r = await jfetch('GET', `/api/plans/${planId}/comparisons`);
    assert.equal(r.status, 200);
    assert.equal(r.data.count, 1);
    const c = r.data.comparisons[0];
    assert.equal(c.older_seq, 1);
    assert.equal(c.newer_seq, 2);
    assert.equal(c.status, 'completed');
    assert.equal(c.pair_count, 2);
    assert.equal(c.older_region_count, 3);
    assert.equal(c.newer_region_count, 3);
    assert.ok(c.completed_at);
  });

  await check('顶点数变化（#2→#3：A-01 4 点→5 点）差异为 vertex_count_changed 且含 added 点', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/comparisons`, { older_seq: 2, newer_seq: 3 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const id3 = r.data.comparison.id;
    // #3 区域：A-01(5点), B-20, D-04；#2 区域：A-01(4点), B-20, D-04
    const done = await jfetch('POST', `/api/plans/${planId}/comparisons/${id3}/complete`, {
      version: 1,
      pairs: [
        { old_code: 'A-01', new_code: 'A-01' },
        { old_code: 'B-20', new_code: 'B-20' },
        { old_code: 'D-04', new_code: 'D-04' },
      ],
    });
    assert.equal(done.status, 201, JSON.stringify(done.data));
    assert.equal(done.data.result.changed_pair_count, 1);
    const aPair = done.data.result.pairs.find((p) => p.old_code === 'A-01');
    assert.equal(aPair.vertices.summary, 'vertex_count_changed');
    assert.equal(aPair.vertices.old_count, 4);
    assert.equal(aPair.vertices.new_count, 5);
    assert.equal(aPair.vertices.added_count, 1);
    assert.equal(aPair.vertices.points.at(-1).change, 'added');
    assert.equal(done.data.result.unpaired_old.count, 0);
    assert.equal(done.data.result.unpaired_new.count, 0);
  });

  await check('空配对也可完成：全部区域列入未配对（结果仍可复看）', async () => {
    const r = await jfetch('POST', `/api/plans/${planId}/comparisons`, { older_seq: 1, newer_seq: 2 });
    assert.equal(r.status, 201);
    const id = r.data.comparison.id;
    const done = await jfetch('POST', `/api/plans/${planId}/comparisons/${id}/complete`, { version: 1 });
    assert.equal(done.status, 201, JSON.stringify(done.data));
    assert.equal(done.data.result.pair_count, 0);
    assert.deepEqual(done.data.result.unpaired_old.codes.sort(), ['A-01', 'B-02', 'C-03']);
    assert.deepEqual(done.data.result.unpaired_new.codes.sort(), ['A-01', 'B-20', 'D-04']);
  });
}

run().then(() => {
  console.log(`\n区域沿革比对 API 测试全部通过（${n} 项）`);
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
