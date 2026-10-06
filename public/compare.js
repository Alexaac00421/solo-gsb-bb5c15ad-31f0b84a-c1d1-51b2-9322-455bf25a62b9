'use strict';
/* 区域沿革比对页：同一图纸两个已发布巡检版并排展示，用户确认/解除/手动改配；
   同编号仅作配对建议。草稿带版本乐观锁；完成后差异结果只读、可复看。 */

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

const RISK_COLORS = {
  '低风险': { fill: 'rgba(22,163,74,.15)', stroke: '#16a34a' },
  '中风险': { fill: 'rgba(217,119,6,.17)', stroke: '#d97706' },
  '高风险': { fill: 'rgba(220,38,38,.18)', stroke: '#dc2626' },
};
const SUGGEST_COLOR = { fill: 'rgba(217,119,6,.08)', stroke: '#d97706' };
const PAIRED_COLOR = { fill: 'rgba(37,99,235,.14)', stroke: '#2563eb' };
const UNPAIRED_COLOR = { fill: 'rgba(107,114,128,.08)', stroke: '#9ca3af' };

const query = new URLSearchParams(location.search);
const planId = query.get('plan');
const cmpIdRaw = query.get('comparison');

const state = {
  mode: 'loading',       // loading | edit | done
  older: null,           // 冻结快照（含 regions）
  newer: null,
  suggestions: [],       // 服务端给出的同编号建议
  serverPairs: [],       // 服务端最新已确认配对
  version: null,         // 所见比对版本
  localPairs: [],        // 本地配对（含用户未提交选择）：{old_code,new_code}，空串表示待选
  result: null,          // 完成后的只读结果
  selectedOld: null,
  selectedNew: null,
  highlightPairIndex: null,
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
function toast(message, kind = 'info', ms = 3400) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, ms);
  setTimeout(() => el.remove(), ms + 400);
}
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
function showEmpty(message, title = '比对无法显示') {
  $('cmpEmpty').classList.remove('hidden');
  $('cmpEmptyTitle').textContent = title;
  $('cmpEmptyText').textContent = message;
}

/* ------------------------------- 初始化 ------------------------------- */

async function init() {
  if (!planId || !/^\d+$/.test(String(planId))) {
    $('cmpTitle').textContent = '参数错误';
    return showEmpty('链接缺少有效的图纸 id（需要 ?plan=<图纸ID>&comparison=<比对ID>）。');
  }
  if (!cmpIdRaw || !/^\d+$/.test(String(cmpIdRaw))) {
    $('cmpTitle').textContent = '参数错误';
    return showEmpty('链接缺少有效的比对任务 id（需要 ?plan=<图纸ID>&comparison=<比对ID>）。');
  }
  await reload({ preserveLocal: false });
}

/** 拉取任务详情；草稿态进入编辑界面，完成态进入只读结果界面 */
async function reload({ preserveLocal = true } = {}) {
  try {
    const detail = await api('GET', `/api/plans/${planId}/comparisons/${cmpIdRaw}`);
    if (detail.status === 'completed') {
      applyResult(detail.result);
      return;
    }
    applyDraft(detail, preserveLocal);
  } catch (err) {
    $('cmpTitle').textContent = '加载失败';
    showEmpty(err.message);
  }
}

/** 用服务端草稿状态刷新界面；本地未提交选择（含待选行）默认保留 */
function applyDraft(detail, preserveLocal) {
  state.mode = 'edit';
  state.older = detail.older;
  state.newer = detail.newer;
  state.suggestions = detail.suggestions || [];
  state.serverPairs = detail.pairs || [];
  state.version = detail.comparison.version;

  // 以本地配对为工作区；服务端新增/变更的配对合并进来（同旧编号一行）
  if (!preserveLocal) {
    state.localPairs = state.serverPairs.map((p) => ({ ...p }));
  } else {
    const serverByOld = new Map(state.serverPairs.map((p) => [p.old_code, p.new_code]));
    const localOlds = new Set();
    for (const lp of state.localPairs) {
      localOlds.add(lp.old_code);
      if (lp.old_code && serverByOld.has(lp.old_code) &&
          lp.new_code === '' && serverByOld.get(lp.old_code) !== lp.new_code) {
        // 本地是待选行，服务端已被他人配上：以服务端为准，避免占用冲突
        lp.new_code = serverByOld.get(lp.old_code);
      }
    }
    for (const [oldCode, newCode] of serverByOld) {
      if (!localOlds.has(oldCode)) state.localPairs.push({ old_code: oldCode, new_code: newCode });
    }
  }

  $('cmpEmpty').classList.add('hidden');
  $('cmpWorkspace').hidden = false;
  $('cmpResultPanel').hidden = true;

  const c = detail.comparison;
  $('cmpTitle').textContent = `${c.plan_name} · 区域沿革比对`;
  $('cmpBack').href = `/inspector.html?plan=${planId}&seq=${c.newer_seq}`;
  $('cmpBadges').innerHTML = `
    <span class="badge">旧版 #${c.older_seq}（${c.older_region_count} 区）</span>
    <span class="badge">→ 新版 #${c.newer_seq}（${c.newer_region_count} 区）</span>
    <span class="badge badge-live">🚧 配对中 · 比对版本 v${c.version}</span>
    ${c.inspector ? `<span class="badge">巡检人：${esc(c.inspector)}</span>` : ''}`;
  $('cmpActions').innerHTML = `
    <a class="btn header-btn" href="/api/plans/${planId}/comparisons/${c.id}" target="_blank" rel="noopener">任务 JSON</a>
    <a class="btn header-btn" href="/inspector.html?plan=${planId}&seq=${c.newer_seq}">返回巡检版</a>`;

  $('oldSeq').textContent = c.older_seq;
  $('newSeq').textContent = c.newer_seq;
  $('oldMeta').textContent = `图纸 v${state.older.plan_version} · ${state.older.published_at}`;
  $('newMeta').textContent = `图纸 v${state.newer.plan_version} · ${state.newer.published_at}`;
  renderSideImage('old', state.older, c.older_seq);
  renderSideImage('new', state.newer, c.newer_seq);

  renderAll();
  fitView('old');
  fitView('new');
}

/* ------------------------------- 配对工作区渲染 ------------------------------- */

const oldRegions = () => (state.older ? state.older.regions : []);
const newRegions = () => (state.newer ? state.newer.regions : []);

function renderAll() {
  renderSuggestions();
  renderPairs();
  renderRegionLists();
  renderPolygons();
}

function renderSuggestions() {
  const ul = $('cmpSuggestions');
  ul.innerHTML = '';
  const pending = state.suggestions.filter((s) => {
    // 已经在工作区里成对存在的建议不再列出
    return !state.localPairs.some((p) => p.old_code === s.old_code && p.new_code === s.new_code);
  });
  $('cmpSugCount').textContent = `（${pending.length} 条待确认）`;
  for (const s of pending) {
    const li = document.createElement('li');
    li.className = 'suggestion-item';
    li.innerHTML = `
      <span class="risk-dot ${esc(riskOf('old', s.old_code))}"></span>
      <span class="sug-code">${esc(s.old_code)}</span>
      <span class="muted">⇄</span>
      <span class="risk-dot ${esc(riskOf('new', s.new_code))}"></span>
      <span class="sug-code">${esc(s.new_code)}</span>
      <span class="tag-sug">同编号建议</span>
      <span class="sug-actions"></span>`;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '确认配对';
    btn.addEventListener('click', () => {
      if (!canAddPair(s.old_code, s.new_code)) {
        toast(`「${s.old_code}」或「${s.new_code}」已在其他配对行中，请先解除占用`, 'err');
        return;
      }
      state.localPairs.push({ old_code: s.old_code, new_code: s.new_code });
      renderAll();
    });
    li.querySelector('.sug-actions').appendChild(btn);
    ul.appendChild(li);
  }
  if (!pending.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '没有待确认的同编号建议（可在下方手动配对）';
    ul.appendChild(li);
  }
  const adoptBtn = $('btnAdoptAll');
  adoptBtn.disabled = !pending.length;
}

function riskOf(side, code) {
  const hit = (side === 'old' ? oldRegions() : newRegions()).find((r) => r.code === code);
  return hit ? hit.risk_level : '';
}

function canAddPair(oldCode, newCode) {
  const oldBusy = state.localPairs.some((p) => p.old_code === oldCode);
  const newBusy = state.localPairs.some((p) => p.new_code === newCode);
  return !oldBusy && !newBusy;
}

function renderPairs() {
  const ul = $('cmpPairs');
  ul.innerHTML = '';
  const complete = state.localPairs.filter((p) => p.old_code && p.new_code);
  const dup = findDuplicateOccupation();
  $('cmpPairCount').textContent = `（${complete.length} 对${dup ? '，存在重复占用' : ''}）`;
  $('cmpLocalHint').textContent = localDirty()
    ? `有未保存的配对选择（所见版本 v${state.version}）`
    : `已与服务端一致（v${state.version}）`;
  $('cmpLocalHint').className = 'hint' + (localDirty() ? ' local-dirty' : '');

  state.localPairs.forEach((p, index) => {
    const li = document.createElement('li');
    li.className = 'pair-row';
    li.dataset.index = index;
    if (index === state.highlightPairIndex) li.classList.add('selected');

    const oldSel = buildSelect('old', p.old_code, index, true);
    const newSel = buildSelect('new', p.new_code, index, false);
    li.appendChild(oldSel);
    const arrow = document.createElement('span');
    arrow.className = 'pair-arrow';
    arrow.textContent = '⇄';
    li.appendChild(arrow);
    li.appendChild(newSel);

    const meta = document.createElement('span');
    meta.className = 'pair-meta';
    const o = oldRegions().find((r) => r.code === p.old_code);
    const nw = newRegions().find((r) => r.code === p.new_code);
    if (o && nw) {
      const risks = o.risk_level === nw.risk_level
        ? esc(o.risk_level)
        : `${esc(o.risk_level)} → ${esc(nw.risk_level)}`;
      meta.innerHTML = risks;
    } else if (!p.old_code || !p.new_code) {
      meta.textContent = '待选择…';
      meta.classList.add('muted');
    }
    li.appendChild(meta);

    const unlink = document.createElement('button');
    unlink.className = 'btn btn-mini';
    unlink.textContent = '解除';
    unlink.title = '解除这一对（两侧编号回到未配对）';
    unlink.addEventListener('click', () => {
      state.localPairs.splice(index, 1);
      state.highlightPairIndex = null;
      renderAll();
    });
    li.appendChild(unlink);

    if ((p.old_code && dupOld(p.old_code, index)) ||
        (p.new_code && dupNew(p.new_code, index))) {
      li.classList.add('pair-conflict');
    }
    li.addEventListener('click', (e) => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON' ||
          e.target.tagName === 'OPTION') return;
      state.highlightPairIndex = state.highlightPairIndex === index ? null : index;
      state.selectedOld = p.old_code || null;
      state.selectedNew = p.new_code || null;
      renderRegionLists();
      renderPolygons();
    });
    ul.appendChild(li);
  });

  const msg = $('cmpValidate');
  if (dup) {
    msg.className = 'validate-msg err';
    msg.textContent = dup;
    $('btnSaveDraft').disabled = true;
    $('btnComplete').disabled = true;
  } else {
    msg.className = 'validate-msg';
    msg.textContent = '';
    $('btnSaveDraft').disabled = false;
    $('btnComplete').disabled = false;
  }
}

function dupOld(code, index) {
  return state.localPairs.some((p, i) => i !== index && p.old_code === code);
}
function dupNew(code, index) {
  return state.localPairs.some((p, i) => i !== index && p.new_code === code);
}
function findDuplicateOccupation() {
  const olds = new Map();
  const news = new Map();
  for (const p of state.localPairs) {
    if (p.old_code) olds.set(p.old_code, (olds.get(p.old_code) || 0) + 1);
    if (p.new_code) news.set(p.new_code, (news.get(p.new_code) || 0) + 1);
  }
  for (const [code, cnt] of olds) if (cnt > 1) return `旧版区域「${code}」出现在多对中，每个区域至多参与一对`;
  for (const [code, cnt] of news) if (cnt > 1) return `新版区域「${code}」出现在多对中，每个区域至多参与一对`;
  return null;
}

/** 构造一侧编号下拉：当前值 + 其他空闲编号；占用编号标灰提示来自哪一行 */
function buildSelect(side, value, index, isOld) {
  const wrap = document.createElement('label');
  wrap.className = 'pair-select';
  const sel = document.createElement('select');
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = isOld ? '选择旧版编号…' : '选择新版编号…';
  sel.appendChild(blank);

  const regions = isOld ? oldRegions() : newRegions();
  for (const r of regions) {
    const opt = document.createElement('option');
    opt.value = r.code;
    const otherRow = state.localPairs.findIndex((p, i) =>
      i !== index && (isOld ? p.old_code === r.code : p.new_code === r.code));
    opt.textContent = otherRow >= 0 ? `${r.code}（已在第 ${otherRow + 1} 行占用）` : `${r.code} · ${r.risk_level}`;
    if (otherRow >= 0) opt.disabled = true;
    sel.appendChild(opt);
  }
  sel.value = value || '';
  sel.addEventListener('change', () => {
    const p = state.localPairs[index];
    const v = sel.value;
    // 选择已被其他行占用的编号 → 改配：把对方行的该侧清空（交换占用）
    const otherIdx = state.localPairs.findIndex((q, i) => {
      if (i === index) return false;
      return isOld ? q.old_code === v : q.new_code === v;
    });
    if (isOld) p.old_code = v; else p.new_code = v;
    if (otherIdx >= 0) {
      if (isOld) state.localPairs[otherIdx].old_code = '';
      else state.localPairs[otherIdx].new_code = '';
      toast(`已改配：编号「${v}」移到本行，原配对行该侧已解除`, 'info', 3000);
    }
    renderAll();
  });
  wrap.appendChild(sel);
  return wrap;
}

/* ------------------------------- 两侧清单与画布 ------------------------------- */

function sideCodes(side) {
  const regions = side === 'old' ? oldRegions() : newRegions();
  const used = new Set(state.localPairs.map((p) => side === 'old' ? p.old_code : p.new_code));
  return { regions, used };
}

function renderRegionLists() {
  renderOneRegionList('old', 'oldRegionList');
  renderOneRegionList('new', 'newRegionList');
}

function renderOneRegionList(side, listId) {
  const ul = $(listId);
  ul.innerHTML = '';
  const { regions, used } = sideCodes(side);
  for (const r of regions) {
    const curSelected = side === 'old' ? state.selectedOld : state.selectedNew;
    const li = document.createElement('li');
    li.className = 'compare-region-item' + (used.has(r.code) ? ' paired' : ' free') +
      (curSelected === r.code ? ' selected' : '');
    li.innerHTML = `
      <span class="risk-dot ${esc(r.risk_level)}"></span>
      <span class="r-code">${esc(r.code)}</span>
      <span class="muted">${esc(r.risk_level)}</span>
      <span class="region-state">${used.has(r.code) ? '已配对' : '未配对'}</span>`;
    li.addEventListener('click', () => {
      const idx = state.localPairs.findIndex((p) =>
        side === 'old' ? p.old_code === r.code : p.new_code === r.code);
      state.highlightPairIndex = idx >= 0 ? idx : null;
      if (side === 'old') state.selectedOld = r.code;
      else state.selectedNew = r.code;
      // 同时高亮配对行的另一侧编号，便于对照
      if (idx >= 0) {
        const p = state.localPairs[idx];
        if (side === 'old') state.selectedNew = p.new_code || null;
        else state.selectedOld = p.old_code || null;
      }
      renderPairs();
      renderRegionLists();
      renderPolygons();
    });
    ul.appendChild(li);
  }
}

function renderSideImage(side, pub, seq) {
  const prefix = side === 'old' ? 'old' : 'new';
  const url = `/api/plans/${planId}/publications/${seq}/image`;
  const img = $(`${prefix}Image`);
  img.setAttribute('href', url);
  img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
  img.setAttribute('width', pub.width);
  img.setAttribute('height', pub.height);
  $(`${prefix}Bg`).setAttribute('width', pub.width);
  $(`${prefix}Bg`).setAttribute('height', pub.height);
}

function renderPolygons() {
  renderOnePolygons('old', 'oldRegionLayer', oldRegions());
  renderOnePolygons('new', 'newRegionLayer', newRegions());
}

function renderOnePolygons(side, layerId, regions) {
  const layer = $(layerId);
  layer.innerHTML = '';
  const used = new Set(state.localPairs.map((p) => side === 'old' ? p.old_code : p.new_code));
  const suggested = new Set(state.suggestions
    .filter((s) => !state.localPairs.some((p) =>
      side === 'old' ? p.old_code === s.old_code : p.new_code === s.new_code))
    .map((s) => side === 'old' ? s.old_code : s.new_code));
  const selected = side === 'old' ? state.selectedOld : state.selectedNew;

  for (const r of regions) {
    let c = UNPAIRED_COLOR;
    if (used.has(r.code)) c = PAIRED_COLOR;
    else if (suggested.has(r.code)) c = SUGGEST_COLOR;
    const poly = document.createElementNS(SVGNS, 'polygon');
    poly.setAttribute('points', pointsStr(r.vertices));
    poly.setAttribute('fill', c.fill);
    poly.setAttribute('stroke', c.stroke);
    poly.setAttribute('class', 'polygon-region inspector-poly compare-poly' +
      (selected === r.code ? ' selected' : ''));
    poly.dataset.code = r.code;
    poly.addEventListener('click', () => clickRegion(side, r.code));
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

function clickRegion(side, code) {
  const idx = state.localPairs.findIndex((p) =>
    side === 'old' ? p.old_code === code : p.new_code === code);
  state.highlightPairIndex = idx >= 0 ? idx : null;
  state.selectedOld = side === 'old' ? code : (idx >= 0 ? state.localPairs[idx].old_code : state.selectedOld);
  state.selectedNew = side === 'new' ? code : (idx >= 0 ? state.localPairs[idx].new_code : state.selectedNew);
  renderPairs();
  renderRegionLists();
  renderPolygons();
}

/* ------------------------------- 本地脏状态 ------------------------------- */

function localDirty() {
  if (state.localPairs.length !== state.serverPairs.length) return true;
  const key = (p) => `${p.old_code}␟${p.new_code}`;
  const serverKeys = new Set(state.serverPairs.map(key));
  return state.localPairs.some((p) => !p.old_code || !p.new_code || !serverKeys.has(key(p)));
}

function completePairsForSubmit() {
  return state.localPairs.filter((p) => p.old_code && p.new_code)
    .map((p) => ({ old_code: p.old_code, new_code: p.new_code }));
}

/* ------------------------------- 保存 / 冲突 ------------------------------- */

async function saveDraft() {
  if (findDuplicateOccupation()) {
    toast('存在重复占用的区域，请先解除或改配后再保存', 'err');
    return;
  }
  const pairs = completePairsForSubmit();
  const btn = $('btnSaveDraft');
  btn.disabled = true;
  try {
    const res = await api('PUT',
      `/api/plans/${planId}/comparisons/${cmpIdRaw}/pairs`,
      { pairs, version: state.version });
    applyDraft(res, true);
    toast(res.message || `草稿已保存（比对版本 v${res.comparison.version}）`, 'ok');
  } catch (err) {
    handleWriteError(err, '保存');
  } finally {
    btn.disabled = false;
  }
}

function handleWriteError(err, action) {
  if (err.status === 409 && err.data && err.data.server) {
    const server = err.data.server;
    if (server.status === 'completed') {
      applyResult(server.result);
      toast(`该比对已被他人完成并锁定，${action}未生效；以下为最终只读结果`, 'err', 7000);
      return;
    }
    // 版本冲突：刷新服务端最新配对，本地未提交选择（含待选行）原样保留
    const localSnapshot = state.localPairs.map((p) => ({ ...p }));
    applyDraft(server, true);
    state.localPairs = mergeLocalWithServer(localSnapshot, server.pairs);
    renderAll();
    toast(`版本冲突，${action}未生效：${err.message}`, 'err', 7000);
  } else {
    toast(`${action}失败：${err.message}`, 'err', 6000);
  }
}

/**
 * 冲突后合并：保留用户未提交的选择。
 * 规则：服务端已有的配对（按旧编号）若用户未在本地动过则采用服务端；
 * 用户本地改动/待选行只要不与服务端行直接撞编号就保留。
 */
function mergeLocalWithServer(local, serverPairs) {
  const result = [];
  const localByOld = new Map(local.filter((p) => p.old_code).map((p) => [p.old_code, p]));
  const usedOld = new Set();
  const usedNew = new Set();
  // 先放服务端行；用户本地若把同一旧编号改配到别的新编号，以本地为准（保留未提交选择）
  for (const sp of serverPairs) {
    const lp = localByOld.get(sp.old_code);
    if (lp && lp.new_code && lp.new_code !== sp.new_code) {
      result.push({ ...lp });
      usedOld.add(lp.old_code);
      usedNew.add(lp.new_code);
    } else {
      result.push({ ...sp });
      usedOld.add(sp.old_code);
      usedNew.add(sp.new_code);
    }
  }
  // 再补用户的本地行（待选行、手动新配），跳过会造成重复占用的
  for (const lp of local) {
    if (!lp.old_code && !lp.new_code) {
      result.push({ ...lp }); // 纯待选手动行原样保留
      continue;
    }
    if (!lp.old_code || usedOld.has(lp.old_code)) continue;
    if (lp.new_code && usedNew.has(lp.new_code)) continue;
    result.push({ ...lp });
    if (lp.old_code) usedOld.add(lp.old_code);
    if (lp.new_code) usedNew.add(lp.new_code);
  }
  return result;
}

$('btnSaveDraft').addEventListener('click', saveDraft);
$('btnRefresh').addEventListener('click', async () => {
  const snap = state.localPairs.map((p) => ({ ...p }));
  await reload({ preserveLocal: true });
  if (state.mode === 'edit') state.localPairs = mergeLocalWithServer(snap, state.serverPairs);
  if (state.mode === 'edit') renderAll();
  toast('已刷新为服务端最新状态（未提交的选择仍保留）', 'info', 2600);
});
$('btnAddPair').addEventListener('click', () => {
  state.localPairs.push({ old_code: '', new_code: '' });
  state.highlightPairIndex = state.localPairs.length - 1;
  renderAll();
  // 滚动到新行并聚焦旧版下拉
  const rows = $('cmpPairs').querySelectorAll('.pair-row');
  const last = rows[rows.length - 1];
  if (last) {
    last.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const sel = last.querySelector('select');
    if (sel) sel.focus();
  }
});
$('btnAdoptAll').addEventListener('click', () => {
  let added = 0, skipped = 0;
  for (const s of state.suggestions) {
    if (state.localPairs.some((p) => p.old_code === s.old_code || p.new_code === s.new_code)) {
      skipped += 1;
      continue;
    }
    state.localPairs.push({ old_code: s.old_code, new_code: s.new_code });
    added += 1;
  }
  renderAll();
  toast(added ? `已采纳 ${added} 条建议${skipped ? `，${skipped} 条因占用跳过（可手动改配）` : ''}，确认无误后请保存/生成差异`
    : '没有可采纳的建议（均已占用，可解除后重试或手动改配）', added ? 'ok' : 'info', 4000);
});

/* ------------------------------- 完成 ------------------------------- */

$('btnComplete').addEventListener('click', async () => {
  if (findDuplicateOccupation()) {
    toast('存在重复占用的区域，请先解除或改配', 'err');
    return;
  }
  const pairs = completePairsForSubmit();
  const oldFree = oldRegions().length - new Set(pairs.map((p) => p.old_code)).size;
  const newFree = newRegions().length - new Set(pairs.map((p) => p.new_code)).size;
  if (!confirm(
    `确认锁定当前配对并生成差异结果？\n\n` +
    `已配对 ${pairs.length} 对；旧版未配对 ${oldFree} 个、新版未配对 ${newFree} 个将单列。\n` +
    `完成后结果只读，不随后续编辑或发布改变。`)) return;

  const btn = $('btnComplete');
  btn.disabled = true;
  try {
    const res = await api('POST',
      `/api/plans/${planId}/comparisons/${cmpIdRaw}/complete`,
      { pairs, version: state.version });
    applyResult(res.result);
    toast(res.message || '差异结果已生成并锁定（只读）', 'ok', 6000);
  } catch (err) {
    handleWriteError(err, '完成');
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------- 只读结果 ------------------------------- */

function applyResult(result) {
  state.mode = 'done';
  state.result = result;
  $('cmpEmpty').classList.add('hidden');
  $('cmpWorkspace').hidden = true;
  $('cmpResultPanel').hidden = false;

  $('cmpTitle').textContent = `${result.plan_name} · 区域沿革差异（只读）`;
  $('cmpBack').href = `/inspector.html?plan=${planId}&seq=${result.newer.seq}`;
  $('cmpBadges').innerHTML = `
    <span class="badge">旧版 #${result.older.seq}（${result.older.region_count} 区）</span>
    <span class="badge">→ 新版 #${result.newer.seq}（${result.newer.region_count} 区）</span>
    <span class="badge badge-done">✅ 已完成（只读）</span>`;
  $('cmpActions').innerHTML = `
    <a class="btn header-btn" href="/api/plans/${planId}/comparisons/${result.comparison_id}" target="_blank" rel="noopener">结果 JSON</a>
    <a class="btn header-btn" href="/inspector.html?plan=${planId}&seq=${result.newer.seq}">返回巡检版</a>`;
  $('cmpDoneText').textContent =
    `共 ${result.pair_count} 对配对，其中 ${result.changed_pair_count} 对存在变化；` +
    `旧版 ${result.unpaired_old.count} 个、新版 ${result.unpaired_new.count} 个区域未配对。` +
    (result.completed_at ? ` 完成时间 ${result.completed_at}。` : '');

  $('oldSeq').textContent = result.older.seq;
  $('newSeq').textContent = result.newer.seq;
  $('oldMeta').textContent = `图纸 v${result.older.plan_version} · ${result.older.published_at}`;
  $('newMeta').textContent = `图纸 v${result.newer.plan_version} · ${result.newer.published_at}`;
  renderResultSide('old', result.older, result);
  renderResultSide('new', result.newer, result);
  renderResultPairs(result);
  renderUnpaired(result);
  fitView('old');
  fitView('new');
}

function renderResultSide(side, meta, result) {
  const prefix = side === 'old' ? 'old' : 'new';
  const url = `/api/plans/${planId}/publications/${meta.seq}/image`;
  const img = $(`${prefix}Image`);
  img.setAttribute('href', url);
  img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
  img.setAttribute('width', meta.width);
  img.setAttribute('height', meta.height);
  $(`${prefix}Bg`).setAttribute('width', meta.width);
  $(`${prefix}Bg`).setAttribute('height', meta.height);

  // 区域 = 配对中的该侧 + 未配对
  const paired = result.pairs.map((p) => side === 'old' ? p.old_region : p.new_region);
  const unpaired = side === 'old' ? result.unpaired_old.regions : result.unpaired_new.regions;
  const all = paired.concat(unpaired);
  const unpairedSet = new Set(unpaired.map((r) => r.code));

  const ul = $(`${prefix}RegionList`);
  ul.innerHTML = '';
  for (const r of all) {
    const li = document.createElement('li');
    li.className = 'compare-region-item ' + (unpairedSet.has(r.code) ? 'free' : 'paired');
    li.innerHTML = `
      <span class="risk-dot ${esc(r.risk_level)}"></span>
      <span class="r-code">${esc(r.code)}</span>
      <span class="muted">${esc(r.risk_level)}</span>
      <span class="region-state">${unpairedSet.has(r.code) ? '未配对' : '已配对'}</span>`;
    ul.appendChild(li);
  }

  const layer = $(`${prefix}RegionLayer`);
  layer.innerHTML = '';
  for (const r of all) {
    const c = unpairedSet.has(r.code) ? UNPAIRED_COLOR : PAIRED_COLOR;
    const poly = document.createElementNS(SVGNS, 'polygon');
    poly.setAttribute('points', pointsStr(r.vertices));
    poly.setAttribute('fill', c.fill);
    poly.setAttribute('stroke', c.stroke);
    poly.setAttribute('class', 'polygon-region inspector-poly compare-poly');
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

function renderResultPairs(result) {
  const ul = $('cmpResultPairs');
  ul.innerHTML = '';
  $('cmpResPairCount').textContent =
    `（${result.pair_count} 对，${result.changed_pair_count} 对有变化）`;
  for (const p of result.pairs) {
    const li = document.createElement('li');
    li.className = 'result-pair-card' + (p.changes.length ? ' changed' : ' same');
    const changeTags = [];
    if (p.code_changed) changeTags.push('<span class="chg-tag chg-code">编号变化</span>');
    if (p.risk_level.changed) changeTags.push('<span class="chg-tag chg-risk">风险等级变化</span>');
    if (p.vertices.changed) changeTags.push('<span class="chg-tag chg-vert">顶点变化</span>');
    if (!changeTags.length) changeTags.push('<span class="chg-tag chg-none">无变化</span>');

    let vertDetail = '';
    if (p.vertices.changed) {
      const v = p.vertices;
      const lines = [];
      if (v.old_count !== v.new_count) {
        lines.push(`顶点数 ${v.old_count} → ${v.new_count}` +
          (v.added_count ? `，新增 ${v.added_count}` : '') +
          (v.removed_count ? `，删除 ${v.removed_count}` : ''));
      }
      if (v.moved_count) lines.push(`${v.moved_count} 个顶点位移`);
      const moved = v.points.filter((pt) => pt.change === 'moved')
        .map((pt) => `#${pt.index}: (${pt.old.x},${pt.old.y})→(${pt.new.x},${pt.new.y}) Δ(${pt.delta.dx},${pt.delta.dy})`)
        .slice(0, 20);
      vertDetail = `
        <div class="vert-summary">${esc(lines.join('；'))}</div>
        <details><summary>查看逐点变化</summary>
          <table class="vert-table">
            <thead><tr><th>#</th><th>变化</th><th>旧</th><th>新</th><th>Δ</th></tr></thead>
            <tbody>
              ${v.points.map((pt) => `<tr class="v-${pt.change}">
                <td>${pt.index}</td><td>${({ same: '不变', moved: '位移', added: '新增', removed: '删除' })[pt.change]}</td>
                <td>${pt.old ? `(${pt.old.x}, ${pt.old.y})` : '—'}</td>
                <td>${pt.new ? `(${pt.new.x}, ${pt.new.y})` : '—'}</td>
                <td>${pt.change === 'moved' ? `(${pt.delta.dx}, ${pt.delta.dy})` : ''}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>`;
    } else {
      vertDetail = '<div class="vert-summary muted">顶点与顶点数均无变化</div>';
    }

    li.innerHTML = `
      <div class="result-pair-head">
        <span class="risk-dot ${esc(p.old_region.risk_level)}"></span>
        <span class="rp-code">${esc(p.old_code)}</span>
        <span class="muted">⇄</span>
        <span class="risk-dot ${esc(p.new_region.risk_level)}"></span>
        <span class="rp-code">${esc(p.new_code)}</span>
        <span class="rp-tags">${changeTags.join('')}</span>
      </div>
      <div class="result-pair-body">
        <div>风险等级：
          <span class="${p.risk_level.changed ? 'val-changed' : ''}">${esc(p.risk_level.old)}</span>
          ${p.risk_level.changed ? '→ <span class="val-changed">' + esc(p.risk_level.new) + '</span>' : ''}
        </div>
        ${vertDetail}
      </div>`;
    ul.appendChild(li);
  }
  if (!result.pairs.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '本次比对没有确认任何配对，两侧区域全部列入未配对。';
    ul.appendChild(li);
  }
}

function renderUnpaired(result) {
  const box = $('cmpUnpaired');
  const list = (title, arr, cls) => `
    <div class="unpaired-block ${cls}">
      <strong>${title}（${arr.length}）</strong>
      ${arr.length ? `<ul class="unpaired-list">${arr.map((r) =>
        `<li><span class="risk-dot ${esc(r.risk_level)}"></span>${esc(r.code)} <span class="muted">${esc(r.risk_level)}</span></li>`).join('')}</ul>`
      : '<p class="muted">无</p>'}
    </div>`;
  box.innerHTML =
    list('旧版未配对（新版中删除/未确认）', result.unpaired_old.regions, 'unpaired-old') +
    list('新增于新版（旧版未配对）', result.unpaired_new.regions, 'unpaired-new');
}

window.addEventListener('beforeunload', (e) => {
  if (state.mode === 'edit' && localDirty()) { e.preventDefault(); e.returnValue = ''; }
});

/* ------------------------------- 双画布视口 ------------------------------- */

function makeViewport(side, svgId, viewId, zoomId) {
  const svg = $(svgId);
  const v = state.views[side];
  function apply() {
    $(viewId).setAttribute('transform', `translate(${v.tx} ${v.ty}) scale(${v.scale})`);
    $(zoomId).textContent = `缩放 ${Math.round(v.scale * 100)}%`;
  }
  function pub() {
    if (state.mode === 'done') return side === 'old' ? state.result.older : state.result.newer;
    return side === 'old' ? state.older : state.newer;
  }
  function fit() {
    const p = pub();
    if (!p) return;
    const rect = svg.getBoundingClientRect();
    const pad = 20;
    const s = Math.min(
      (rect.width - pad * 2) / p.width,
      (rect.height - pad * 2) / p.height
    );
    v.scale = Math.min(8, Math.max(0.05, s));
    v.tx = (rect.width - p.width * v.scale) / 2;
    v.ty = (rect.height - p.height * v.scale) / 2;
    apply();
  }
  svg.addEventListener('wheel', (e) => {
    if (!pub()) return;
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const ns = Math.min(20, Math.max(0.05, v.scale * Math.exp(-e.deltaY * 0.0015)));
    const f = ns / v.scale;
    v.tx = mx - (mx - v.tx) * f;
    v.ty = my - (my - v.ty) * f;
    v.scale = ns;
    apply();
  }, { passive: false });
  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.classList && e.target.classList.contains('compare-poly')) return;
    v.drag = { x: e.clientX, y: e.clientY };
    svg.classList.add('panning');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!v.drag) return;
    v.tx += e.clientX - v.drag.x;
    v.ty += e.clientY - v.drag.y;
    v.drag.x = e.clientX; v.drag.y = e.clientY;
    apply();
  });
  window.addEventListener('mouseup', () => { v.drag = null; svg.classList.remove('panning'); });
  svg.addEventListener('dblclick', (e) => {
    if (e.target.classList && e.target.classList.contains('compare-poly')) return;
    fit();
  });
  window.addEventListener('resize', () => pub() && apply());
  return { fit };
}

const viewOld = makeViewport('old', 'oldSvg', 'oldViewport', 'oldZoom');
const viewNew = makeViewport('new', 'newSvg', 'newViewport', 'newZoom');
function fitView(side) { (side === 'old' ? viewOld : viewNew).fit(); }

init();
