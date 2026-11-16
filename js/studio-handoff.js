/* ==========================================================================
 * studio-handoff.js · 「一键出片」按钮 + 对话框（v35）
 *
 * 人在页面上点一下就能跑完整条流水线（等价 Agent 的 wb_handoff）：
 *   选 GLB（上传）或已登记资产 → 时长/fps/分辨率/环绕圈数 → 开始出片
 *   → 桥上跑 upload/import/track/submit/poll/download → HUD 显示实时进度
 *   → 完成后列出本地产物 + 自动写入版本记录（供 A/B 对比）
 * ========================================================================== */
import { studioBase, absStudioUrl, resolveStudioBase } from './studio-endpoint.js?v=77';
const BRIDGE = 'http://127.0.0.1:8787';
// ★ 端口不写死（见 studio-endpoint.js）
const STUDIO = () => studioBase();
let dlg = null;
let busy = false;

const $ = (s, r) => (r || document).querySelector(s);

function toast(msg, kind = 'ok') {
  const box = $('#toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
}

async function bridgeTool(name, args) {
  const r = await fetch(BRIDGE + '/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args: args || {} }),
  });
  return r.json();
}

async function registeredAssets() {
  try {
    const r = await fetch(studioBase() + '/api/studio/assets');
    const j = await r.json();
    return (j.data?.assets || []);
  } catch (_) { return []; }
}

/* ------------------------------------------------------------ */
/* 对话框                                                        */
/* ------------------------------------------------------------ */
async function build() {
  if (dlg && document.body.contains(dlg)) return dlg;
  const el = document.createElement('div');
  el.id = 'handoffDlg';
  el.className = 'ho-dialog';
  el.innerHTML = `
    <div class="ho-card">
      <header><b>一键出片</b><span class="ho-sub">Agent 造 → 工作台排 → Blender 渲</span><button type="button" data-close>×</button></header>
      <div class="ho-body">
        <div class="ho-row">
          <label>模型来源</label>
          <select id="hoAsset"><option value="">（正在读取已登记资产…）</option></select>
        </div>
        <div class="ho-row">
          <label>或上传 GLB</label>
          <input type="file" id="hoFile" accept=".glb">
        </div>
        <div class="ho-grid">
          <label>时长 <input type="number" id="hoSec" value="2" min="1" max="60" step="0.5"> s</label>
          <label>帧率 <select id="hoFps"><option>24</option><option>30</option></select></label>
          <label>分辨率 <select id="hoRes">
            <option value="640x360">640×360（快）</option>
            <option value="1280x720" selected>1280×720</option>
            <option value="1920x1080">1920×1080</option>
          </select></label>
          <label>环绕 <input type="number" id="hoTurns" value="1" min="0" max="3" step="0.25"> 圈</label>
        </div>
        <div class="ho-row">
          <label>轨迹</label>
          <label class="ho-check"><input type="checkbox" id="hoUsePage"> 用页面轨迹（手绘 / Agent 下发的 keys），不用自动环绕</label>
        </div>
        <div class="ho-row">
          <label>文件名前缀</label>
          <input type="text" id="hoPrefix" value="白膜" maxlength="20">
        </div>
        <div class="ho-actions">
          <button type="button" class="ho-btn ghost" id="hoCheck">交接体检</button>
          <button type="button" class="ho-btn" id="hoRun">开始出片</button>
        </div>
        <div class="ho-progress" id="hoProg" hidden><i></i><span>准备中…</span></div>
        <div class="ho-steps" id="hoSteps"></div>
        <div class="ho-files" id="hoFiles"></div>
        <div class="ho-hint">出片期间右下角会显示 Blender 实时进度（帧级 + 最新帧缩略图），可以继续编辑场景。</div>
      </div>
    </div>`;
  document.body.appendChild(el);
  dlg = el;
  el.addEventListener('click', (ev) => {
    if (ev.target === el || ev.target.closest('[data-close]')) { if (!busy) el.remove(); dlg = null; }
  });
  $('#hoRun', el).onclick = () => run();
  $('#hoCheck', el).onclick = () => check();
  $('#hoFile', el).onchange = () => {
    const f = $('#hoFile', el).files[0];
    if (f) $('#hoAsset', el).value = '';
  };
  const assets = await registeredAssets();
  const sel = $('#hoAsset', el);
  sel.innerHTML = '<option value="">（不用已有资产，上传新 GLB）</option>' +
    assets.map(a => `<option value="${a.id}">${a.name} · ${Math.round(a.bytes / 1024)} KB</option>`).join('');
  return el;
}

function setProgress(pct, text) {
  const box = $('#hoProg', dlg);
  if (!box) return;
  box.hidden = false;
  box.querySelector('i').style.width = Math.max(0, Math.min(100, pct)) + '%';
  box.querySelector('span').textContent = text || '';
}

async function check() {
  setProgress(30, '体检中：导出规范场景…');
  const res = await bridgeTool('wb_handoff_check', {});
  const box = $('#hoSteps', dlg);
  setProgress(100, res.ok ? '体检通过' : '体检发现问题');
  box.innerHTML = res.ok
    ? `<div class="ho-ok">✓ 体检通过：${res.data.assets} 资产 / ${res.data.instances} 实例 / ${res.data.frames} 帧 / ${res.data.keys} 关键帧 · ${res.data.coordinates?.up || '?'}-up</div>`
    : `<div class="ho-err">✗ ${(res.issues || [res.error]).join('；')}</div>`;
}

async function run() {
  if (busy) return;
  busy = true;
  const btn = $('#hoRun', dlg);
  btn.disabled = true; btn.textContent = '出片中…';
  $('#hoFiles', dlg).innerHTML = '';
  $('#hoSteps', dlg).innerHTML = '';
  setProgress(6, '准备：登记模型…');

  try {
    let assetId = $('#hoAsset', dlg).value;
    const file = $('#hoFile', dlg).files[0];
    if (file) {
      if (!window.WBStudio) throw new Error('页面桥未就绪（刷新一次）');
      setProgress(10, '上传 GLB → Blender 资产库…');
      const asset = await window.WBStudio.upload(file);
      assetId = asset.id;
    }
    if (!assetId) throw new Error('请选一个已登记资产，或上传一个 .glb');

    const [w, h] = $('#hoRes', dlg).value.split('x').map(Number);
    const args = {
      asset_id: assetId,
      seconds: Number($('#hoSec', dlg).value) || 2,
      fps: Number($('#hoFps', dlg).value) || 24,
      width: w, height: h,
      turns: Number($('#hoTurns', dlg).value) || 1,
      prefix: ($('#hoPrefix', dlg).value || '白膜').trim(),
      use_page_track: !!$('#hoUsePage', dlg).checked,
    };
    setProgress(18, '导入 → 生成轨迹 → 提交 Blender…（右下角看实时进度）');
    const res = await bridgeTool('wb_handoff', args);
    if (!res.ok) { setProgress(100, '失败'); $('#hoSteps', dlg).innerHTML = `<div class="ho-err">✗ ${res.error}</div>`; return; }

    setProgress(100, '完成');
    const d = res.data;
    $('#hoSteps', dlg).innerHTML = `<div class="ho-ok">✓ ${d.blender} · ${d.render.width}×${d.render.height} · ${d.render.frame_count} 帧 · ${(d.elapsed_ms / 1000).toFixed(1)}s · 校验 ${d.validation?.passed ? '通过' : '异常'}</div>` +
      `<div class="ho-steps-line">${(res.steps || []).map(s => s.step).join(' → ')}</div>`;
    $('#hoFiles', dlg).innerHTML = (d.files || []).map(f =>
      `<div class="ho-file"><span>${f.kind === 'video' ? '视频 MP4' : '首帧 PNG'}</span><em>${Math.round(f.bytes / 1024)} KB</em><code title="${f.path || ''}">${f.path || '(未下载)'}</code></div>`).join('');

    // 写入版本记录（A/B 对比用）
    const ed = window.__wb && window.__wb.editor;
    if (window.WBRevisions) {
      window.WBRevisions.add({
        job_id: d.job_id,
        scene_id: d.scene_id || ed?.studioSceneId || null,
        revision: d.revision ?? ed?.studioRevision ?? null,
        render: d.render,
        outputs: d.outputs || [],
        prefix: args.prefix,
        turns: args.turns,
        blender: d.blender,
        files: d.files,
      });
      toast('已写入版本记录，可在「版本对比」里 A/B');
    }
    if (window.__wb?.pipCam) { /* 保持用户当前视角，不动 */ }
  } catch (e) {
    setProgress(100, '失败');
    $('#hoSteps', dlg).innerHTML = `<div class="ho-err">✗ ${e.message}</div>`;
  } finally {
    busy = false;
    btn.disabled = false; btn.textContent = '开始出片';
  }
}

function open() { build().then((el) => { el.hidden = false; el.style.display = 'grid'; }); }

/* 顶栏按钮 */
let mounted = false;
function mount() {
  if (mounted) return;
  const bridge = document.querySelector('#wbBlenderBridge');
  if (!bridge || !bridge.parentNode) return;
  const b = document.createElement('button');
  b.id = 'wbHandoff';
  b.className = 'tb-btn main';
  b.type = 'button';
  b.textContent = '一键出片';
  b.title = '选模型 + 参数，一条命令跑完上传/摆位/运镜/Blender 渲染/产物落盘';
  b.onclick = open;
  bridge.parentNode.insertBefore(b, bridge.nextSibling);
  mounted = true;
}
const mo = new MutationObserver(() => mount());
mo.observe(document.body, { childList: true, subtree: true });
mount();

window.WBHandoff = { open, run, check };
