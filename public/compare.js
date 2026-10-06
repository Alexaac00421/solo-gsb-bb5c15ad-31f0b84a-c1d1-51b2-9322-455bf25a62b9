'use strict';
/* 版本对比页：并排展示同一图纸两个已发布巡检版的冻结图纸与区域清单，
 * 用户确认/解除/手动改配区域配对；保存草稿带版本号（冲突保留本地未提交选择）；
 * 完成后生成只读差异结果（编号 / 风险等级 / 顶点变化 + 两侧未配对区域）。 */

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

/* 配对连线配色：同一对区域在两侧使用同一颜色，便于并排核对 */
const PAIR_COLORS = [
  '#2563eb', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#dc2626',
];
const UNPAIRED_COLOR = { fill: 'rgba(107,114,128,.10)', stroke: '#9ca3af' };

const query = new URLSearchParams(location.search);
const planId = query.get('plan');
const cmpIdRaw = query.get('comparison');

const state = {
  detail: null,          // 服务端对比任务详情
  version: null,         // 当前服务端任务版本（乐观锁基准）
  localPairs: [],        // 本地工作配对集（含未提交修改）
  dirty: false,          // localPairs 与服务端 pairs 不一致
  sel: { old: null, new: null }, // 手动配对的两侧选中编号
  views: {
    old: { scale: 1, tx: 0, ty: 0, drag: null },
    new: { scale: 1, tx: 0, ty: 0, drag: null },
  },
};

/* ------------------------------- 基础工具 ------------------------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pointsStr(verts) { return verts.map((p) => `${p.x},${p.y}`).join(' '); }
function centroid(verts) {
  let x = 0, y = 0;
  for (const p of verts) { x += p.x; y += p.y; }
  return { x: x / verts.length, y: y / verts.length };
}
const pairKey = (p) => `${p.old_code}→${p.new_code}`;

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* 无响应体 */ }
  if (!res.ok) {
    const err = new Error((data && data.message) || `请求失败：HTTP ${res.status}`);
    err.status = res.status;
    err.code = data && data.error;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(message, kind = 'info', ms = 3400) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, ms);
  setTimeout(() => el.remove(), ms + 400);
}

function showEmpty(message, title = '对比任务无法显示') {
  $('cmpEmpty').classList.remove('hidden');
  $('cmpEmptyTitle').textContent = title;
  $('cmpEmptyText').textContent = message;
}

const isCompleted = () => state.detail && state.detail.comparison.status === 'completed';

/* ------------------------------- 初始化加载 ------------------------------- */

async function init() {
  if (!planId || !/^\d+$/.test(String(planId))) {
    $('cmpTitle').textContent = '参数错误';
    showEmpty('链接缺少有效的图纸 id（需要 ?plan=<图纸ID>&comparison=<对比任务ID>）。');
    return;
  }
  if (!cmpIdRaw || !/^\d+$/.test(String(cmpIdRaw))) {
    $('cmpTitle').textContent = '参数错误';
    showEmpty('链接缺少有效的对比任务 id（需要 ?plan=<图纸ID>&comparison=<对比任务ID>）。');
    return;
  }
  try {
    const detail = await api('GET', `/api/plans/${planId}/comparisons/${cmpIdRaw}`);
    applyServer(detail, { keepLocal: false });
  } catch (err) {
    $('cmpTitle').textContent = '加载失败';
    showEmpty(err.message);
  }
}

/** 用服务端最新详情刷新界面；keepLocal=true 时保留本地未提交的配对选择 */
function applyServer(detail, { keepLocal = true } = {}) {
  state.detail = detail;
  state.version = detail.comparison.version;
  if (!keepLocal) {
    state.localPairs = detail.pairs.map((p) => ({ ...p }));
    state.dirty = false;
    state.sel = { old: null, new: null };
  }
  $('cmpEmpty').classList.add('hidden');

  const c = detail.comparison;
  $('cmpTitle').textContent =
    `${c.plan_name} · 第 ${c.old_seq} 号 → 第 ${c.new_seq} 号巡检版`;
  $('cmpBack').href = `/inspector.html?plan=${planId}&seq=${c.new_seq}`;
  const statusBadge = c.status === 'completed'
    ? '<span class="badge badge-done">✅ 已完成（只读）</span>'
    : '<span class="badge badge-live">🚧 配对中</span>';
  $('cmpBadges').innerHTML = `
    <span class="badge">第 ${c.seq} 次对比</span>
    <span class="badge">旧版 #${c.old_seq}（${detail.old_publication.region_count} 区）</span>
    <span class="badge">新版 #${c.new_seq}（${detail.new_publication.region_count} 区）</span>
    <span class="badge">任务版本 v${c.version}</span>
    ${statusBadge}`;
  $('cmpActions').innerHTML = `
    <a class="btn header-btn" href="/api/plans/${planId}/comparisons/${c.id}" target="_blank" rel="noopener">对比 JSON</a>
    <a class="btn header-btn" href="/inspector.html?plan=${planId}&seq=${c.old_seq}">旧版巡检页</a>
    <a class="btn header-btn" href="/inspector.html?plan=${planId}&seq=${c.new_seq}">新版巡检页</a>`;

  $('cmpPairSection').hidden = isCompleted();
  $('cmpPairsSection').hidden = isCompleted();
  $('cmpDoneSection').hidden = !isCompleted();
  $('cmpResultSection').hidden = !isCompleted();
  if (isCompleted()) {
    $('cmpDoneText').textContent =
      `完成于 ${c.completed_at}：共 ${c.pair_count} 对，两侧未配对区域见下方差异结果。`;
    renderResult();
  }

  renderSideHeads();
  renderCanvases();
  renderSideLists();
  if (!isCompleted()) renderPairing();
  fitView('old');
  fitView('new');
}

/* ------------------------------- 配对工作区 ------------------------------- */

/** 相同编号建议（基于本地工作集计算）：两侧都有该编号且均未参与配对 */
function currentSuggestions() {
  const pairedOld = new Set(state.localPairs.map((p) => p.old_code));
  const pairedNew = new Set(state.localPairs.map((p) => p.new_code));
  const newCodes = new Set(state.detail.new_regions.map((r) => r.code));
  return state.detail.old_regions
    .filter((r) => newCodes.has(r.code) && !pairedOld.has(r.code) && !pairedNew.has(r.code))
    .map((r) => r.code);
}

function markDirty() {
  state.dirty = true;
  renderPairing();
  renderCanvases();
  renderSideLists();
}

function renderPairing() {
  // 建议区
  const box = $('cmpSuggestBox');
  box.innerHTML = '';
  const suggestions = currentSuggestions();
  if (suggestions.length) {
    const div = document.createElement('div');
    div.className = 'cmp-suggest';
    div.innerHTML = `<div class="muted" style="margin-bottom:4px">相同编号建议（${suggestions.length}）—— 仅建议，需确认：</div>`;
    for (const code of suggestions) {
      const row = document.createElement('div');
      row.className = 'cmp-suggest-item';
      row.innerHTML = `<span>⇄ ${esc(code)}</span>`;
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = '确认';
      btn.addEventListener('click', () => {
        state.localPairs.push({ old_code: code, new_code: code });
        markDirty();
      });
      row.appendChild(btn);
      div.appendChild(row);
    }
    box.appendChild(div);
  }
  $('btnAcceptAll').disabled = !suggestions.length;
  $('btnAcceptAll').textContent = suggestions.length
    ? `全部确认建议（${suggestions.length}）` : '全部确认建议';

  // 配对列表（本地工作集）
  const ul = $('cmpPairList');
  ul.innerHTML = '';
  $('cmpPairCount').textContent = `（${state.localPairs.length} 对${state.dirty ? ' · 有未保存修改' : ''}）`;
  if (!state.localPairs.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '尚未确认任何配对';
    ul.appendChild(li);
  }
  state.localPairs.forEach((p, i) => {
    const li = document.createElement('li');
    const color = PAIR_COLORS[i % PAIR_COLORS.length];
    const renamed = p.old_code !== p.new_code;
    li.innerHTML = `
      <span class="cmp-pair-dot" style="background:${color}"></span>
      <span class="r-code">${esc(p.old_code)}</span>
      <span class="cmp-arrow">→</span>
      <span class="r-code">${esc(p.new_code)}</span>
      ${renamed ? '<span class="badge">编号变更</span>' : ''}`;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '解除';
    btn.title = '解除该配对（两侧区域变为未配对）';
    btn.addEventListener('click', () => {
      state.localPairs.splice(i, 1);
      markDirty();
    });
    li.appendChild(btn);
    ul.appendChild(li);
  });

  // 保存 / 完成按钮状态与提示
  const msg = $('cmpMsg');
  $('btnSavePairs').disabled = !state.dirty;
  if (state.dirty) {
    msg.textContent = '有未保存的配对修改：保存草稿后才能完成对比';
    msg.className = 'validate-msg';
  } else {
    msg.textContent = '';
  }
}

$('btnAcceptAll').addEventListener('click', () => {
  for (const code of currentSuggestions()) {
    state.localPairs.push({ old_code: code, new_code: code });
  }
  markDirty();
});

/* ------------------------------- 保存草稿 ------------------------------- */

$('btnSavePairs').addEventListener('click', savePairs);

async function savePairs() {
  const btn = $('btnSavePairs');
  btn.disabled = true;
  try {
    const res = await api('PUT', `/api/plans/${planId}/comparisons/${state.detail.comparison.id}/pairs`, {
      version: state.version,
      pairs: state.localPairs,
    });
    hideConflict();
    applyServer(res, { keepLocal: false });
    if (res.changed === false) toast('配对内容未变化（与服务端一致）', 'info', 2400);
    else toast(`配对草稿已保存（任务 v${res.comparison.version}）`, 'ok');
  } catch (err) {
    handleWriteError(err);
  } finally {
    btn.disabled = false;
  }
}

/** 409：保留本地未提交配对，同时给出服务端最新配对状态供对照 */
function handleWriteError(err) {
  if (err.status === 409 && err.data && err.data.server) {
    const server = err.data.server;
    state.detail = server;
    state.version = server.comparison.version; // 基准推进到最新，由用户决定是否重存
    showConflict(server, err.message);
    if (err.code === 'COMPARISON_COMPLETED') {
      // 他人已完成：任务只读，本地修改无法提交，整体刷新为只读视图
      toast(`对比已被他人完成并锁定：${err.message}`, 'err', 7000);
      applyServer(server, { keepLocal: false });
      return;
    }
    toast(`版本冲突，未覆盖你的配对选择：${err.message}`, 'err', 7000);
    renderPairing();
    renderCanvases();
    renderSideLists();
  } else if (err.code === 'UNKNOWN_REGION' || err.code === 'PAIR_REGION_REUSED' ||
             err.code === 'VALIDATION_ERROR') {
    toast(err.message, 'err', 6500);
  } else {
    toast(`保存失败：${err.message}`, 'err', 6000);
  }
}

function showConflict(server, message) {
  const box = $('cmpConflictBox');
  box.classList.remove('hidden');
  box.innerHTML = `
    <strong>⚠ 他人已更新配对（服务端 v${server.comparison.version}，${server.pairs.length} 对）</strong>
    <p class="muted">你本地的 ${state.localPairs.length} 对未提交修改仍保留在页面上。
      可对照服务端最新配对后重新保存（将整体覆盖服务端配对），或放弃本地修改载入服务端配对。</p>
    <div class="cmp-conflict-server">服务端当前配对：${
      server.pairs.length
        ? server.pairs.map((p) => `${esc(p.old_code)}→${esc(p.new_code)}`).join('、')
        : '（空）'
    }</div>
    <div class="btn-row" style="margin-top:6px">
      <button class="btn primary" id="btnConflictSave">以我的配对重新保存</button>
      <button class="btn" id="btnConflictLoad">载入服务端配对</button>
    </div>`;
  $('btnConflictSave').addEventListener('click', savePairs);
  $('btnConflictLoad').addEventListener('click', () => {
    state.localPairs = server.pairs.map((p) => ({ ...p }));
    state.dirty = false;
    hideConflict();
    renderPairing();
    renderCanvases();
    renderSideLists();
    toast('已载入服务端最新配对，本地未提交修改已放弃', 'info');
  });
}
function hideConflict() { $('cmpConflictBox').classList.add('hidden'); }

/* ------------------------------- 完成对比 ------------------------------- */

$('btnCompleteCmp').addEventListener('click', async () => {
  if (state.dirty) {
    toast('有未保存的配对修改：请先「保存配对草稿」，再完成对比', 'err', 5000);
    return;
  }
  const c = state.detail.comparison;
  const unpairedOld = state.detail.old_regions.length - state.localPairs.length;
  const unpairedNew = state.detail.new_regions.length - state.localPairs.length;
  if (!confirm(
    `确认完成第 ${c.seq} 次版本对比（第 ${c.old_seq} 号 → 第 ${c.new_seq} 号巡检版）？\n` +
    `当前共 ${state.localPairs.length} 对；旧版 ${unpairedOld} 个、新版 ${unpairedNew} 个区域未配对（将列入结果）。\n` +
    `完成后配对与差异结果只读，不可再修改。`)) return;

  const btn = $('btnCompleteCmp');
  btn.disabled = true;
  try {
    const res = await api('POST',
      `/api/plans/${planId}/comparisons/${c.id}/complete`,
      { version: state.version });
    hideConflict();
    applyServer(res, { keepLocal: false });
    toast(res.message || '对比已完成，差异结果只读', 'ok', 5000);
  } catch (err) {
    handleWriteError(err);
  } finally {
    btn.disabled = false;
  }
});

$('btnRefreshCmp').addEventListener('click', async () => {
  try {
    const detail = await api('GET', `/api/plans/${planId}/comparisons/${state.detail.comparison.id}`);
    applyServer(detail, { keepLocal: true });
    toast('已刷新为服务端最新状态（本地未提交的配对仍保留）', 'info', 2600);
  } catch (err) {
    toast('刷新失败：' + err.message, 'err');
  }
});

/* 有未提交配对时提醒不要直接离开 */
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ------------------------------- 差异结果 ------------------------------- */

function renderResult() {
  const r = state.detail.result;
  if (!r) return;
  const s = r.summary;
  $('cmpResultSummary').innerHTML = `
    <div class="meta-row">
      <span class="badge">${s.pair_count} 对（${s.changed_pairs} 对有变化 / ${s.unchanged_pairs} 对无变化）</span>
      <span class="badge">旧版未配对 ${s.unpaired_old_count}</span>
      <span class="badge">新版未配对 ${s.unpaired_new_count}</span>
    </div>`;

  const ul = $('cmpResultPairs');
  ul.innerHTML = '';
  if (!r.pairs.length) {
    ul.innerHTML = '<li class="muted">没有任何配对，两侧全部区域均为未配对</li>';
  }
  r.pairs.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'cmp-result-card' + (p.changed ? '' : ' unchanged');
    const color = PAIR_COLORS[i % PAIR_COLORS.length];
    const head = `
      <div class="cmp-result-head">
        <span class="cmp-pair-dot" style="background:${color}"></span>
        <span class="r-code">${esc(p.old_code)}</span>
        <span class="cmp-arrow">→</span>
        <span class="r-code">${esc(p.new_code)}</span>
        ${p.code_changed ? '<span class="cmp-changed">编号变更</span>' : ''}
        ${p.changed ? '' : '<span class="muted">（无变化）</span>'}
      </div>`;
    const riskLine = p.risk_level.changed
      ? `<div class="diff-line">风险等级：${esc(p.risk_level.old)} <span class="cmp-arrow">→</span> <span class="cmp-changed">${esc(p.risk_level.new)}</span></div>`
      : `<div class="diff-line muted">风险等级：${esc(p.risk_level.old)}（不变）</div>`;
    let vertLine;
    if (!p.vertices.changed) {
      vertLine = `<div class="diff-line muted">顶点：${p.vertices.old_count} 个（不变）</div>`;
    } else if (p.vertices.old_count !== p.vertices.new_count) {
      vertLine = `<div class="diff-line">顶点：<span class="cmp-changed">数量 ${p.vertices.old_count} → ${p.vertices.new_count}</span></div>`;
    } else {
      const moves = p.vertices.moves.map((m) =>
        `#${m.index + 1} (${m.from.x}, ${m.from.y}) → (${m.to.x}, ${m.to.y})`).join('；');
      vertLine = `<div class="diff-line">顶点：<span class="cmp-changed">${p.vertices.moves.length} 个移动</span>（共 ${p.vertices.old_count} 个）<br><span class="muted">${esc(moves)}</span></div>`;
    }
    li.innerHTML = head + riskLine + vertLine;
    ul.appendChild(li);
  });

  const un = $('cmpResultUnpaired');
  const renderUn = (list, label) => list.length
    ? `<div class="cmp-unpaired-col"><strong>${label}（${list.length}）</strong><ul>${
        list.map((x) => `<li><span class="risk-dot ${esc(x.risk_level)}"></span>${esc(x.code)}<span class="muted"> ${esc(x.risk_level)}</span></li>`).join('')
      }</ul></div>`
    : `<div class="cmp-unpaired-col"><strong>${label}</strong><p class="muted">无</p></div>`;
  un.innerHTML = `<div class="cmp-unpaired">${
    renderUn(r.unpaired_old, `旧版 #${r.old_seq} 未配对`)}${
    renderUn(r.unpaired_new, `新版 #${r.new_seq} 未配对`)}</div>`;
}

/* ------------------------------- 并排画布 ------------------------------- */

function pairColorOf(side, code) {
  const i = state.localPairs.findIndex((p) =>
    side === 'old' ? p.old_code === code : p.new_code === code);
  return i >= 0 ? PAIR_COLORS[i % PAIR_COLORS.length] : null;
}

function renderSideHeads() {
  const d = state.detail;
  $('cmpOldHead').innerHTML =
    `<strong>旧版 · 第 ${d.old_publication.seq} 号巡检版</strong>` +
    `<span class="muted">图纸 v${d.old_publication.plan_version} · ${d.old_publication.region_count} 区 · 发布于 ${esc(d.old_publication.published_at)}</span>`;
  $('cmpNewHead').innerHTML =
    `<strong>新版 · 第 ${d.new_publication.seq} 号巡检版</strong>` +
    `<span class="muted">图纸 v${d.new_publication.plan_version} · ${d.new_publication.region_count} 区 · 发布于 ${esc(d.new_publication.published_at)}</span>`;
}

function renderCanvases() {
  for (const side of ['old', 'new']) {
    const pub = side === 'old' ? state.detail.old_publication : state.detail.new_publication;
    const regions = side === 'old' ? state.detail.old_regions : state.detail.new_regions;
    const S = side === 'old' ? 'Old' : 'New';
    const url = `/api/plans/${planId}/publications/${pub.seq}/image`;
    const img = $(`cmpImage${S}`);
    img.setAttribute('href', url);
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
    img.setAttribute('width', pub.width);
    img.setAttribute('height', pub.height);
    $(`cmpBg${S}`).setAttribute('width', pub.width);
    $(`cmpBg${S}`).setAttribute('height', pub.height);

    const layer = $(`cmpLayer${S}`);
    layer.innerHTML = '';
    for (const r of regions) {
      const color = pairColorOf(side, r.code);
      const poly = document.createElementNS(SVGNS, 'polygon');
      poly.setAttribute('points', pointsStr(r.vertices));
      poly.setAttribute('fill', color ? color + '2e' : UNPAIRED_COLOR.fill);
      poly.setAttribute('stroke', color || UNPAIRED_COLOR.stroke);
      poly.setAttribute('class', 'polygon-region inspector-poly cmp-poly' +
        (state.sel[side] === r.code ? ' selected' : ''));
      poly.addEventListener('click', () => selectRegion(side, r.code));
      layer.appendChild(poly);

      const ctr = centroid(r.vertices);
      const label = document.createElementNS(SVGNS, 'text');
      label.setAttribute('x', ctr.x);
      label.setAttribute('y', ctr.y);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.setAttribute('class', 'poly-label');
      label.textContent = r.code;
      layer.appendChild(label);
    }
  }
}

function renderSideLists() {
  for (const side of ['old', 'new']) {
    const regions = side === 'old' ? state.detail.old_regions : state.detail.new_regions;
    const ul = side === 'old' ? $('cmpOldList') : $('cmpNewList');
    ul.innerHTML = '';
    for (const r of regions) {
      const pair = state.localPairs.find((p) =>
        side === 'old' ? p.old_code === r.code : p.new_code === r.code);
      const li = document.createElement('li');
      li.classList.toggle('selected', state.sel[side] === r.code);
      li.innerHTML = `
        <span class="risk-dot ${esc(r.risk_level)}"></span>
        <span class="r-code">${esc(r.code)}</span>
        <span class="muted">${esc(r.risk_level)}</span>
        <span class="pair-tag">${pair
          ? `⇄ ${esc(side === 'old' ? pair.new_code : pair.old_code)}`
          : '未配对'}</span>`;
      if (!isCompleted()) {
        li.addEventListener('click', () => selectRegion(side, r.code));
      }
      ul.appendChild(li);
    }
  }
}

/** 手动配对：两侧各选中一个未配对区域即建立一对；已配对区域被选中时提供改配 */
function selectRegion(side, code) {
  if (isCompleted()) return;
  state.sel[side] = state.sel[side] === code ? null : code;
  const { old, new: nw } = state.sel;
  if (old && nw) {
    const usedOld = state.localPairs.findIndex((p) => p.old_code === old);
    const usedNew = state.localPairs.findIndex((p) => p.new_code === nw);
    if (usedOld >= 0 || usedNew >= 0) {
      const msgs = [];
      if (usedOld >= 0) msgs.push(`旧版「${old}」已配给「${state.localPairs[usedOld].new_code}」`);
      if (usedNew >= 0) msgs.push(`新版「${nw}」已配给「${state.localPairs[usedNew].old_code}」`);
      if (!confirm(`${msgs.join('；')}。\n每侧每个区域至多参与一对，是否解除原配对并改配为 ${old} → ${nw}？`)) {
        state.sel = { old: null, new: null };
        renderCanvases();
        renderSideLists();
        return;
      }
      if (usedOld >= 0) state.localPairs.splice(usedOld, 1);
      const idx = state.localPairs.findIndex((p) => p.new_code === nw);
      if (idx >= 0) state.localPairs.splice(idx, 1);
    }
    state.localPairs.push({ old_code: old, new_code: nw });
    state.sel = { old: null, new: null };
    markDirty();
    toast(`已建立配对 ${old} → ${nw}（未保存，记得保存草稿）`, 'info', 2400);
    return;
  }
  renderCanvases();
  renderSideLists();
}

/* ------------------------------- 视口交互 ------------------------------- */

function applyTransform(side) {
  const t = state.views[side];
  const S = side === 'old' ? 'Old' : 'New';
  $(`cmpViewport${S}`).setAttribute('transform',
    `translate(${t.tx} ${t.ty}) scale(${t.scale})`);
  $(`cmpZoom${S}`).textContent = `缩放 ${Math.round(t.scale * 100)}%`;
}

function fitView(side) {
  if (!state.detail) return;
  const pub = side === 'old' ? state.detail.old_publication : state.detail.new_publication;
  const svg = side === 'old' ? $('cmpSvgOld') : $('cmpSvgNew');
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const pad = 30;
  const s = Math.min((rect.width - pad * 2) / pub.width, (rect.height - pad * 2) / pub.height);
  const t = state.views[side];
  t.scale = Math.min(8, Math.max(0.05, s));
  t.tx = (rect.width - pub.width * t.scale) / 2;
  t.ty = (rect.height - pub.height * t.scale) / 2;
  applyTransform(side);
}

for (const side of ['old', 'new']) {
  const svg = side === 'old' ? $('cmpSvgOld') : $('cmpSvgNew');
  svg.addEventListener('wheel', (e) => {
    if (!state.detail) return;
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const t = state.views[side];
    const ns = Math.min(20, Math.max(0.05, t.scale * Math.exp(-e.deltaY * 0.0015)));
    const f = ns / t.scale;
    t.tx = mx - (mx - t.tx) * f;
    t.ty = my - (my - t.ty) * f;
    t.scale = ns;
    applyTransform(side);
  }, { passive: false });
  svg.addEventListener('mousedown', (e) => {
    if (!state.detail || e.button !== 0) return;
    if (e.target.classList && e.target.classList.contains('cmp-poly')) return; // 点区域不触发平移
    state.views[side].drag = { x: e.clientX, y: e.clientY };
    svg.classList.add('panning');
    e.preventDefault();
  });
  svg.addEventListener('dblclick', (e) => {
    if (e.target.classList && e.target.classList.contains('cmp-poly')) return;
    fitView(side);
  });
}
window.addEventListener('mousemove', (e) => {
  for (const side of ['old', 'new']) {
    const d = state.views[side].drag;
    if (!d) continue;
    const t = state.views[side];
    t.tx += e.clientX - d.x;
    t.ty += e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    applyTransform(side);
  }
});
window.addEventListener('mouseup', () => {
  for (const side of ['old', 'new']) {
    state.views[side].drag = null;
    (side === 'old' ? $('cmpSvgOld') : $('cmpSvgNew')).classList.remove('panning');
  }
});
window.addEventListener('resize', () => {
  if (!state.detail) return;
  applyTransform('old');
  applyTransform('new');
});

init();
