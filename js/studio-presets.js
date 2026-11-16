/* ============================================================================
 * js/studio-presets.js —— 预设捕获 / 还原 / 批量出图 / 分享链接
 *
 * 用户要的是「**这些资产可以直接复用，需要的时候直接调出来**」。
 * 于是把"一个画面"整套存下来：
 *   世界怎么来的（城市参数 / OSM 的 URL） + 机位 + 摆了什么 + 灯 + 缩略图
 * ⇒ 之后一个命令就回到那个画面（wb_preset_load）。
 *
 * 渲染机制沿用网站那套思路：**状态即链接**。
 *   网站用 🔗链接をコピー 把 place+camera+style 编码进 URL；
 *   这里同理，用 base64url 把场景状态编码进 ?wb= 参数，
 *   打开链接即可还原 —— 不需要服务器、不需要账号。
 * ========================================================================== */

const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const bridgeUrl = () => `http://127.0.0.1:${(window.WB_BRIDGE_PORT || 8787)}`;

async function callTool(name, args) {
  try {
    const r = await fetch(bridgeUrl() + '/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args: args || {} }),
    });
    const j = await r.json();
    if (j && j.ok) return { ok: true, data: j };
    return { ok: false, error: (j && (j.error || j.data?.error)) || '调用失败' };
  } catch (e) {
    return { ok: false, error: '本地 Agent 桥未启动' };
  }
}

/* ── 状态捕获 ─────────────────────────────────────────────────────────── */

/** 把当前编辑器状态拍成一张"快照对象" */
function captureState() {
  const e = window.__wb && window.__wb.editor;
  if (!e) return null;
  const spec = e._worldSpec || { kind: 'env', env: e.envId, size: e.envSize };
  const assets = (e.objects || []).map((o) => ({
    assetId: o.assetId,
    instanceId: o.instanceId,
    // ★ 2026-11-09：外部模型（资产库里的 GLB）要把**来源信息**带上，
    //   否则分享出去以后对方只看到 assetId='external:xxx'，
    //   还原时找不到内置资产 ⇒ **静默丢掉这个模型**（实测：跨机器打开 ext=0）。
    ext: o.externalAsset ? {
      id: o.externalAsset.id,
      name: o.externalAsset.name || o.externalAsset.id,
      file_url: o.externalAsset.file_url || null,
      partIndex: (o.externalAsset.partIndex != null) ? o.externalAsset.partIndex : null,
    } : null,
    x: +o.group.position.x.toFixed(3),
    y: +o.group.position.y.toFixed(3),
    z: +o.group.position.z.toFixed(3),
    ry: +(o.group.rotation.y * 180 / Math.PI).toFixed(2),
    scale: +o.group.scale.x.toFixed(3),
  }));
  return {
    version: 1,
    spec,
    env: e.envId,
    size: e.envSize,
    camera: {
      r: +e.sph.r.toFixed(3),
      phi: +e.sph.phi.toFixed(4),
      theta: +e.sph.theta.toFixed(4),
      target: e.target.toArray().map((n) => +n.toFixed(3)),
      fov: e.camera.fov,
    },
    light: e.lightOpts ? {
      azimuth: e.lightOpts.azimuth,
      elevation: e.lightOpts.elevation,
      intensity: e.lightOpts.intensity,
      kelvin: e.lightOpts.kelvin,
      soft: e.lightOpts.shadowSoft,
    } : null,
    assets,
    interior: !!(e._interior),
  };
}

/** 还原一个状态 */
async function restoreState(st) {
  const e = window.__wb && window.__wb.editor;
  if (!e) return { ok: false, error: '请先打开一个场景' };
  const spec = st.spec || {};

  // ① 世界
  if (spec.kind === 'osm' && spec.url) {
    try {
      await e.loadOsmWorld({ url: spec.url, attribution: spec.attribution });
    } catch (err) {
      return { ok: false, error: '真实世界载入失败：' + String((err && err.message) || err) };
    }
  } else if (spec.kind === 'env') {
    if (spec.size) e.setEnvSize(spec.size);
    e.loadEnv(spec.env || 'room', { size: spec.size || e.envSize, seed: spec.seed, density: spec.density });
    e._worldSpec = spec;
  }

  // ② 机位
  if (st.camera) {
    if (Array.isArray(st.camera.target)) e.target.fromArray(st.camera.target);
    if (Number.isFinite(st.camera.r)) e.sph.r = st.camera.r;
    if (Number.isFinite(st.camera.phi)) e.sph.phi = st.camera.phi;
    if (Number.isFinite(st.camera.theta)) e.sph.theta = st.camera.theta;
    if (Number.isFinite(st.camera.fov)) e.camera.fov = st.camera.fov;
    if (e._applyCamera) e._applyCamera();
  }

  // ③ 灯
  if (st.light && e.lightOpts) {
    Object.assign(e.lightOpts, st.light);
    if (e.applyLighting) e.applyLighting();
  }

  // ④ 摆的资产（按 instanceId 匹配已有对象，缺了就补）
  const placed = [];
  const missing = [];        // ★ 找不到的（对方机器上没有的外部模型）
  for (const a of (st.assets || [])) {
    let rec = (e.objects || []).find((o) => o.instanceId === a.instanceId);
    if (!rec) rec = (e.objects || []).find((o) => o.assetId === a.assetId);
    if (!rec) {
      // ★ 2026-11-09：外部模型优先用**来源信息**重建
      if (a.ext && e.addExternalAsset) {
        try {
          const url = a.ext.file_url ||
            ('http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/library/file/' + encodeURIComponent(a.ext.id));
          const er = await e.addExternalAsset({ id: a.ext.id, name: a.ext.name, file_url: url },
            { p: [a.x, a.y, a.z], scale: [a.scale, a.scale, a.scale] });
          if (er) {
            er.group.rotation.y = (a.ry * Math.PI) / 180;
            placed.push({ instanceId: er.instanceId, assetId: er.assetId });
            continue;
          }
        } catch (_) { /* 加载失败 → 记进 missing */ }
      }
      // 内置资产
      const isExternal = String(a.assetId || '').startsWith('external:');
      if (isExternal) { missing.push(a.ext ? (a.ext.name || a.ext.id) : a.assetId); continue; }
      if (!e.addAsset) continue;
      try { e.addAsset(a.assetId); rec = e.objects[e.objects.length - 1]; } catch (_) { continue; }
    }
    if (!rec) continue;
    rec.group.position.set(a.x, a.y, a.z);
    rec.group.rotation.y = (a.ry * Math.PI) / 180;
    rec.group.scale.setScalar(a.scale || 1);
    placed.push({ instanceId: rec.instanceId, assetId: rec.assetId });
  }

  // ⑤ 室内
  if (st.interior && e.enterBuilding) {
    try { e.enterBuilding({}); } catch (_) { /* 没有可进的楼就算了 */ }
  }

  // ★ 明确告诉用户少了什么（别静默丢）
  if (missing.length) {
    try { toast('有 ' + missing.length + ' 个外部模型没找到（对方机器上没有）：' + missing.slice(0, 3).join('、'), 'warn', 6000); }
    catch (_) { /* 没有 toast 也不影响 */ }
  }

  return {
    ok: true,
    restored: { spec: spec.kind, assets: placed.length },
    missing,
  };
}

/* ── base64url 编解码（分享链接用） ───────────────────────────────────── */
function b64urlEncode(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/* ── 页面命令注册 ─────────────────────────────────────────────────────── */
export function registerPresetCommands() {
  if (!window.WB_AGENT || !window.WB_AGENT.register) return;
  const reg = window.WB_AGENT.register;

  const regOne = (name, fn) => {
    try { reg(name, fn); } catch (_) { /* 已存在 */ }
  };

  regOne('preset.capture', () => {
    const st = captureState();
    if (!st) return { error: '请先打开一个场景' };
    // 顺手带一张小缩略图，面板上认得出来
    let thumb = null;
    const e = window.__wb.editor;
    try { thumb = e.captureThumb(320, 180); } catch (_) { /* 忽略 */ }
    return { ok: true, state: st, thumb };
  });

  regOne('preset.restore', async (args) => {
    const st = args && args.state ? args.state : args;
    if (!st) return { error: '缺少 state' };
    try {
      return await restoreState(st);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  regOne('share.link', async () => {
    const st = captureState();
    if (!st) return { error: '请先打开一个场景' };
    // ★ 2026-11-09：**优先短链接**（场景存本地，URL 只带 id）。
    //   大场景 base64 内联会长到几千字符，微信/Slack 里可能点不开。
    //   短链接失败（桥没起 / 跨机器访问不到）→ 退回内联模式（离线可分享）。
    try {
      const r = await fetch('http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: st }),
      });
      const j = await r.json();
      if (j && j.ok && j.id) {
        const code = b64urlEncode(st);
        return {
          ok: true,
          url: location.origin + location.pathname + '?s=' + j.id,
          id: j.id,
          expiresAt: j.expiresAt,
          mode: 'short',
          code,
          state: st,
        };
      }
    } catch (_) { /* 桥没起 → 退回内联 */ }
    const code = b64urlEncode(st);
    const base = location.origin + location.pathname;
    return { ok: true, url: base + '?wb=' + code, code, mode: 'inline', state: st };
  });

  // ★ 批量出图：多机位一次拍完（网站那套"一次出多个角度"的思路）
  regOne('render.batch', async (args) => {
    const e = window.__wb && window.__wb.editor;
    if (!e) return { error: '请先打开一个场景' };
    const shots = (args && args.shots) || [];
    if (!shots.length) return { error: '缺少 shots' };
    const w = (args && args.w) || 1920;
    const h = (args && args.h) || 1080;
    const save = (args && args.save) !== false;
    const saved = [];
    const keep = {
      r: e.sph.r, phi: e.sph.phi, theta: e.sph.theta,
      target: e.target.clone(), fov: e.camera.fov,
    };
    for (const s of shots) {
      if (Array.isArray(s.target)) e.target.fromArray(s.target);
      if (Number.isFinite(s.r)) e.sph.r = s.r;
      if (Number.isFinite(s.phi)) e.sph.phi = s.phi;
      if (Number.isFinite(s.theta)) e.sph.theta = s.theta;
      if (Number.isFinite(s.fov)) e.camera.fov = s.fov;
      if (e._applyCamera) e._applyCamera();
      // 等一帧，让相机矩阵真的生效
      // ★ 2026-11-10：**不能只等 rAF**。页面在后台/被遮挡时 Chrome 会**饿死 rAF**
      //   （实测 hidden 页面的第一个 rAF 等了 214 秒）⇒ 批量出图每张都卡 200 多秒，
      //   整体直接超时。加 setTimeout 兜底（后台会被限到 1 秒，但不会饿死）。
      await new Promise((r) => {
        let fired = false;
        const once = () => { if (fired) return; fired = true; r(); };
        requestAnimationFrame(() => requestAnimationFrame(once));
        setTimeout(once, 50);
      });
      const url = e.captureThumb(w, h);
      const base64 = url.split(',')[1];
      const name = (s.name || 'shot').replace(/[^\w一-龥.-]+/g, '_');
      if (save) {
        const res = await callTool('wb_shot_save', { name: name + '.jpg', base64 });
        saved.push({ name, ok: res.ok, path: res.ok ? (res.data && res.data.path) : null, error: res.ok ? null : res.error });
      } else {
        saved.push({ name, ok: true, base64 });
      }
    }
    // 机位还原
    e.target.copy(keep.target);
    e.sph.r = keep.r; e.sph.phi = keep.phi; e.sph.theta = keep.theta;
    e.camera.fov = keep.fov;
    if (e._applyCamera) e._applyCamera();
    return { ok: true, count: saved.length, shots: saved, size: [w, h] };
  });
}

/* ── 打开带 ?wb= 的链接时自动还原 ─────────────────────────────────────── */
export async function restoreFromUrl() {
  // ★ 2026-11-09：两种链接
  //   ?s=<id> → 短链接（场景存在服务端，链接短）
  //   ?wb=<code> → 内联 base64（离线可分享）
  let code = '';
  let shareId = '';
  try {
    const q = new URL(location.href).searchParams;
    code = q.get('wb') || '';
    shareId = q.get('s') || '';
  } catch (_) { code = ''; shareId = ''; }
  if (!code && !shareId) return { ok: false, error: '链接里没有状态' };

  let st = null;
  if (shareId) {
    try {
      const r = await fetch('http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/share/' + encodeURIComponent(shareId));
      const j = await r.json();
      if (!j || !j.ok) return { ok: false, error: (j && j.error) || '这个分享不存在或已过期' };
      st = j.state;
    } catch (e) {
      return { ok: false, error: '读不到分享内容（连不上本地服务）' };
    }
  } else {
    try { st = b64urlDecode(code); } catch (e) { return { ok: false, error: '链接状态解不开' }; }
  }
  // ★ 2026-11-09：**编辑器默认不开**（页面开在入口页）。
  //   之前只"等编辑器就绪"，等 12 秒也不会来 ⇒ **分享链接打开后什么都没还原**。
  //   现在自己开一个（restoreState 里会再把世界/机位覆盖过来）。
  if (!window.__wb || !window.__wb.editor) {
    try {
      if (window.__wb && window.__wb.openEditor) await window.__wb.openEditor({ env: 'room' });
    } catch (_) { /* 下面继续等 */ }
  }
  // 等编辑器就绪
  for (let i = 0; i < 90; i++) {
    if (window.__wb && window.__wb.editor) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!window.__wb || !window.__wb.editor) return { ok: false, error: '编辑器没就绪' };
  try { if (window.__wb.switchView) window.__wb.switchView('editor'); } catch (_) {}
  return await restoreState(st);
}
window.__restoreFromUrl = restoreFromUrl;
window.__captureState = captureState;

/* ── 顶栏动作（存预设 / 批量出图 / 复制链接） ──────────────────────────── */
window.__ovfSavePreset = async function (name) {
  const n = name || prompt('预设名（同名覆盖）', '我的机位_' + Date.now().toString().slice(-5));
  if (!n) return { ok: false, error: '取消了' };
  const r = await callTool('wb_preset_save', { name: n });
  if (!r.ok) alert('保存失败：' + (r.error || '未知'));
  else alert('已存预设：' + n);
  return r;
};

/**
 * 批量出图：绕着当前目标转 N 个角度各出一张。
 * 角度来自「网站那套一次出多角度」的思路 —— 一圈机位，一次拍完。
 */
window.__ovfBatchRender = async function (opts) {
  const o = opts || {};
  const e = window.__wb && window.__wb.editor;
  if (!e) { alert('场景没就绪'); return { ok: false, error: '场景没就绪' }; }
  const n = Math.max(1, Math.min(12, Number(o.count) || 4));
  const r = e.sph.r, phi = e.sph.phi;
  const target = e.target.toArray();
  const shots = [];
  for (let i = 0; i < n; i++) {
    shots.push({
      name: (o.prefix || '机位') + '_' + String(i + 1).padStart(2, '0'),
      r, phi,
      theta: (o.theta0 != null ? Number(o.theta0) : 0) + (i * Math.PI * 2) / n,
      target,
    });
  }
  const res = await callTool('wb_render_batch', {
    shots, w: Number(o.w) || 1920, h: Number(o.h) || 1080, save: true,
  });
  if (!res.ok) { alert('批量出图失败：' + (res.error || '未知')); return res; }
  const paths = (res.data && res.data.shots || []).map((s) => s.path).filter(Boolean);
  alert('出了 ' + (res.data && res.data.count) + ' 张：\n' + paths.join('\n'));
  return res;
};

window.__ovfShareLink = async function () {
  const r = await callTool('wb_share_link', {});
  if (!r.ok) { alert('生成失败：' + (r.error || '未知')); return r; }
  const url = r.data && r.data.url;
  try {
    await navigator.clipboard.writeText(url);
    alert('链接已复制：\n' + url);
  } catch (_) {
    prompt('复制这个链接（打开即可还原画面）：', url);
  }
  return r;
};

/* ── 入口页「预设库」面板 ─────────────────────────────────────────────── */
function renderPresets(list) {
  const grid = $('#presetGrid');
  if (!grid) return;
  if (!list || !list.length) {
    grid.innerHTML = '<div class="src-empty">还没有预设 · 在编辑器里摆好画面后点「存为预设」</div>';
    return;
  }
  grid.innerHTML = list.map((p) => `
    <div class="src-card preset" data-preset="${esc(p.id)}">
      ${p.thumb ? `<img class="preset-thumb" src="${esc(p.thumb)}" alt="">` : '<div class="preset-thumb ph"></div>'}
      <div class="src-head"><b>${esc(p.name)}</b></div>
      <div class="src-what">${esc(p.kind || '场景')}${p.size ? ' · ' + esc(p.size) : ''}${p.assets ? ' · ' + p.assets + ' 个资产' : ''}${p.interior ? ' · 室内' : ''}</div>
      ${p.attribution ? `<div class="src-credit must">${esc(p.attribution)}</div>` : '<div class="src-credit">无署名要求</div>'}
      <div class="src-actions">
        <button class="btn primary" data-act="load" data-preset="${esc(p.id)}">调出来</button>
        <button class="btn ghost" data-act="del" data-preset="${esc(p.id)}">删除</button>
      </div>
    </div>
  `).join('');
}

async function loadPresets() {
  const r = await callTool('wb_preset_list', {});
  const box = $('#presetGrid');
  if (!box) return;
  if (!r.ok) {
    box.innerHTML = '<div class="src-empty">本地 Agent 桥未启动 · 启动后刷新即可看到预设库</div>';
    return;
  }
  renderPresets(r.data && r.data.presets);
}

async function openPreset(id) {
  const r = await callTool('wb_preset_load', { id });
  if (!r.ok) { alert('调不出来：' + (r.error || '未知')); return; }
  // 切到编辑器
  try {
    if (window.__wb && window.__wb.openEditor) await window.__wb.openEditor({ env: 'room' });
    if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  } catch (_) { /* 忽略 */ }
  setTimeout(async () => {
    const rr = await callTool('wb_preset_load', { id });
    if (!rr.ok) alert('还原失败：' + (rr.error || '未知'));
    else location.reload();
  }, 1200);
}

export function initPresets() {
  registerPresetCommands();
  const sec = $('#presetSec');
  if (sec) {
    sec.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.dataset.preset;
      if (btn.dataset.act === 'load') await openPreset(id);
      else if (btn.dataset.act === 'del') {
        if (!confirm('删掉预设「' + id + '」？')) return;
        await callTool('wb_preset_delete', { id });
        await loadPresets();
      }
    });
  }
  const rf = $('#presetRefresh');
  if (rf) rf.addEventListener('click', loadPresets);
  loadPresets();

  // 分享链接：带 ?wb=（内联）或 ?s=（短链接）打开时自动还原
  if (/[?&](wb|s)=/.test(location.search)) {
    setTimeout(async () => {
      const r = await restoreFromUrl();
      if (r && r.ok) {
        try { if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor'); } catch (_) {}
      } else if (r && r.error) {
        try { toast('场景没还原：' + r.error, 'warn', 5000); } catch (_) {}
      }
    }, 2500);
  }
}
window.__initPresets = initPresets;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPresets, { once: true });
} else {
  initPresets();
}
