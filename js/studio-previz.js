import { studioBase, absStudioUrl, resolveStudioBase } from './studio-endpoint.js?v=77';
/* ==========================================================================
 * studio-previz.js · VideoForge 白膜资产回收（v73）
 *
 * 目的：VideoForge 走「白膜 / previz」阶段产出的资产（studio_bridge 下的
 *       scenes / assets / jobs），要能一键收进 OpenVideoForge：
 *         · 白膜场景 → 「我的场景」（含 GLB 实例位姿、机位轨迹、来源留痕）
 *         · 白膜模型 → 「我的模型」（重新登记进 8765 资产库，可复用）
 *         · 渲染任务 → 只作留痕/预览（首帧、成片 URL）
 *
 * 依赖：本地桥 8787 的 wb_previz_* 工具；页面侧只做展示和落库。
 * ========================================================================== */
const BRIDGE = 'http://127.0.0.1:8787';
const VF = () => studioBase();
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function toast(msg, kind = 'ok', ms = 3200) {
  const box = $('#toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

async function call(tool, args = {}) {
  const r = await fetch(BRIDGE + '/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: tool, args }),
  });
  const j = await r.json();
  if (!j || j.ok === false) throw new Error((j && j.error) || '桥调用失败');
  return j.data;
}

const fmtBytes = (n) => {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
};

/* ---------- 导入落库 ---------- */

/** 白膜场景 → 我的场景（native 场景，对象直接是已登记的 GLB） */
async function importScene(sceneId) {
  const d = await call('wb_previz_import_scene', { scene_id: sceneId });
  const objects = (d.objects || []).filter(o => o.externalAsset).map(o => ({
    instanceId: o.instanceId,
    externalAsset: o.externalAsset,
    p: o.p, q: o.q, scale: o.scale,
  }));
  if (!objects.length) throw new Error('这个场景没有可导入的模型');
  // v74：白膜机位 → 页面运镜轨迹（camera.keys 已经是 canon/Y-up）
  const fps = Number(d.render && d.render.fps) || 24;
  const camKeys = (d.camera && Array.isArray(d.camera.keys) ? d.camera.keys : []).map((k, i) => ({
    frame: i,
    position: k.position,
    target: k.target,
    roll: Number(k.roll) || 0,
    vertical_fov: Number(k.vertical_fov) || Number(d.camera && d.camera.vertical_fov) || 45,
  }));
  const duration = camKeys.length ? +(camKeys.length / fps).toFixed(2)
    : (d.render && d.render.frame_count ? +(d.render.frame_count / fps).toFixed(2) : 3);
  const studioTracks = camKeys.length ? {
    camera: { vertical_fov: Number(d.camera && d.camera.vertical_fov) || 45, keys: camKeys },
    object_tracks: [],
    device_tracks: [],
  } : null;
  // 打开场景时的初始视角：直接用白膜第 0 帧机位，避免一进来对着墙
  let camState = null;
  if (camKeys.length) {
    const k0 = camKeys[0];
    const dx = k0.position[0] - k0.target[0];
    const dy = k0.position[1] - k0.target[1];
    const dz = k0.position[2] - k0.target[2];
    const r = Math.max(0.5, Math.hypot(dx, dy, dz));
    camState = {
      r,
      phi: Math.acos(Math.max(-1, Math.min(1, dy / r))),
      theta: Math.atan2(dx, dz),
      t: k0.target.slice(),
      fov: k0.vertical_fov || 45,
      p: k0.position.slice(),
    };
  }
  const trackMeta = camKeys.length ? {
    duration, fps,
    camera: { segments: [], ease: 'linear', y0: 0, y1: 0, look: null, timing: null },
    objects: {}, devices: {}, active: { kind: 'camera' },
  } : null;
  const rec = {
    id: 'previz-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    type: 'native',
    title: d.title || ('白膜 · ' + String(d.scene_id || sceneId).slice(-8)),
    thumb: d.thumb_url ? absStudioUrl(d.thumb_url) : null,
    source: 'videoforge-previz',
    previz: {
      scene_id: d.scene_id || sceneId,
      revision: d.revision,
      job_id: d.job_id || null,
      imported_at: Date.now(),
      failed_assets: d.failed_assets || [],
    },
    data: {
      v: 2,
      env: 'room',
      externalEnvironment: true,
      objects,
      cams: [],
      camera: camState,
      studioTracks,
      trackMeta,
      studioRender: d.render ? { fps, width: d.render.width, height: d.render.height, frame_count: d.render.frame_count, duration } : null,
      devices: [],
    },
    createdAt: Date.now(),
  };
  if (window.WBSceneImport && window.WBSceneImport.add) window.WBSceneImport.add(rec);
  else throw new Error('页面入口未就绪（WBSceneImport 缺失）');
  return rec;
}

/** 白膜模型 → 我的模型（重新登记到 8765 + localStorage 记录来源） */
async function importModel(assetId) {
  const d = await call('wb_previz_import_model', { asset_id: assetId });
  const asset = d.asset;
  if (window.WBMyAssets && window.WBMyAssets.add) {
    window.WBMyAssets.add(asset, {
      source: 'videoforge-previz',
      previz_asset_id: assetId,
      at: Date.now(),
    });
  }
  return asset;
}

/* ---------- 弹窗 ---------- */

let dlg = null;
let data = null;

function ensureDialog() {
  if (dlg && document.body.contains(dlg)) return dlg;
  const el = document.createElement('div');
  el.id = 'previzDlg';
  el.className = 'pv-overlay';
  el.hidden = true;
  el.innerHTML = `
    <div class="pv-card">
      <div class="pv-head">
        <b>从 VideoForge 白膜导入</b>
        <span class="pv-sub">白膜阶段产出的场景 / 模型，收进这里就能复用（来源留痕）</span>
        <button type="button" class="pv-x" data-pv="close">✕</button>
      </div>
      <div class="pv-tabs">
        <button type="button" class="pv-tab on" data-pvtab="scenes">白膜场景</button>
        <button type="button" class="pv-tab" data-pvtab="models">白膜模型</button>
        <button type="button" class="pv-tab" data-pvtab="jobs">渲染记录</button>
        <span class="pv-count" id="pvCount"></span>
      </div>
      <div class="pv-body" id="pvBody"></div>
      <div class="pv-foot">
        <span class="pv-hint">来源：<code>%LOCALAPPDATA%\\VideoForge\\data\\studio_bridge</code> · 导入后可在「我的场景 / 我的模型」继续用</span>
        <button type="button" class="btn" data-pv="close">关闭</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', async (e) => {
    const close = e.target.closest('[data-pv="close"]');
    if (close) { el.hidden = true; return; }
    const tab = e.target.closest('[data-pvtab]');
    if (tab) { $$('.pv-tab', el).forEach(x => x.classList.toggle('on', x === tab)); render(el, tab.dataset.pvtab); return; }
    const saveJob = e.target.closest('[data-save-job]');
    if (saveJob) {
      saveJob.disabled = true; saveJob.textContent = '保存中…';
      try {
        const r = await call('wb_render_save', { job_id: saveJob.dataset.saveJob, prefix: '白膜_' });
        const files = (r && r.data && (r.data.files || r.data.saved)) || r.data || {};
        toast('已存到输出目录：' + (r.data && r.data.out_dir ? r.data.out_dir : '（见回执）'), 'ok', 4200);
        saveJob.textContent = '已保存 ✓';
        console.log('wb_render_save', r);
      } catch (err) { toast('保存失败：' + (err.message || err), 'warn', 5000); saveJob.disabled = false; saveJob.textContent = '存到输出目录'; }
      return;
    }
    const imp = e.target.closest('[data-import]');
    if (imp) {
      const kind = imp.dataset.kind, id = imp.dataset.import;
      imp.disabled = true; imp.textContent = '导入中…';
      try {
        if (kind === 'scene') {
          const rec = await importScene(id);
          toast('已导入场景「' + rec.title + '」：' + (rec.data.objects.length) + ' 个模型 → 我的场景');
          el.hidden = true;
        } else if (kind === 'model') {
          const a = await importModel(id);
          toast('已导入模型「' + (a.name || id) + '」→ 我的模型');
          imp.textContent = '已导入 ✓';
          return;
        }
      } catch (err) {
        toast('导入失败：' + (err.message || err), 'warn', 5000);
        imp.disabled = false; imp.textContent = '导入';
      }
    }
  });
  dlg = el;
  return el;
}

function render(el, tab) {
  const body = $('#pvBody', el);
  const count = $('#pvCount', el);
  if (!data) { body.innerHTML = '<div class="pv-empty">读取中…</div>'; return; }
  if (tab === 'scenes') {
    const list = data.scenes || [];
    count.textContent = list.length + ' 个';
    body.innerHTML = list.length ? list.map(s => `
      <div class="pv-row">
        <span class="pv-thumb">${s.thumb_url ? `<img src="${VF + s.thumb_url}" alt="" loading="lazy">` : '<span class="ph">◍</span>'}</span>
        <span class="pv-info">
          <span class="pv-name">${s.scene_id}</span>
          <span class="pv-meta">${s.assets} 资产 · ${s.instances} 实例${s.frame_count ? ` · ${s.frame_count} 帧 / ${s.fps || 24}fps` : ''}${s.camera_keys ? ` · 机位 ${s.camera_keys} 关键帧` : ''}</span>
        </span>
        <button type="button" class="btn pv-do" data-kind="scene" data-import="${s.scene_id}">导入</button>
      </div>`).join('') : '<div class="pv-empty">没有白膜场景 —— 先在 VideoForge 里跑一轮白膜渲染</div>';
  } else if (tab === 'models') {
    const list = data.models || [];
    count.textContent = list.length + ' 个';
    body.innerHTML = list.length ? list.map(m => `
      <div class="pv-row">
        <span class="pv-thumb"><span class="ph">◈</span></span>
        <span class="pv-info">
          <span class="pv-name">${m.name}</span>
          <span class="pv-meta">${fmtBytes(m.bytes)} · ${new Date((m.created_at || 0) * 1000).toLocaleString('zh-CN')}</span>
        </span>
        <button type="button" class="btn pv-do" data-kind="model" data-import="${m.id}">导入</button>
      </div>`).join('') : '<div class="pv-empty">没有白膜模型</div>';
  } else {
    const list = data.jobs || [];
    count.textContent = list.length + ' 个';
    body.innerHTML = list.length ? list.map(j => `
      <div class="pv-row">
        <span class="pv-thumb"><img src="${VF + j.first_frame_url}" alt="" loading="lazy"></span>
        <span class="pv-info">
          <span class="pv-name">${j.job_id}</span>
          <span class="pv-meta">${j.status} · ${j.frames || '?'} 帧${j.duration ? ` · ${j.duration}s` : ''} · ${new Date((j.created_at || 0) * 1000).toLocaleString('zh-CN')}</span>
        </span>
        <a class="btn pv-do" href="${VF + j.video_url}" target="_blank" rel="noreferrer">看片</a>
        <button type="button" class="btn pv-do" data-save-job="${j.job_id}">存到输出目录</button>
      </div>`).join('') : '<div class="pv-empty">没有渲染任务</div>';
  }
}

async function open(tab = 'scenes') {
  const el = ensureDialog();
  el.hidden = false;
  $$('.pv-tab', el).forEach(x => x.classList.toggle('on', x.dataset.pvtab === tab));
  render(el, tab);
  try {
    data = await call('wb_previz_list');
    render(el, tab);
  } catch (e) {
    $('#pvBody', el).innerHTML = '<div class="pv-empty">读不到白膜资产：' + (e.message || e) + '<br><span style="opacity:.7">确认 VideoForge 正在运行、桥 8787 在线</span></div>';
  }
}

/* ---------- 入口按钮 ---------- */
function addButton(anchorSel, tab, label) {
  const anchor = document.querySelector(anchorSel);
  if (!anchor || document.querySelector('[data-previz-open="' + tab + '"]')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pv-open';
  b.dataset.previzOpen = tab;
  b.textContent = label || '从白膜导入';
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); open(tab); };
  anchor.insertAdjacentElement('afterend', b);
}

function init() {
  const put = () => {
    addButton('#modelCount', 'models', '从白膜导入模型');
    addButton('#enCount', 'scenes', '从白膜导入场景');
  };
  put();
  // app.js 重渲染会替换计数节点，定时补回（成本可忽略）
  setInterval(put, 1500);
  window.WBPreviz = { open, importScene, importModel, list: () => call('wb_previz_list') };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
