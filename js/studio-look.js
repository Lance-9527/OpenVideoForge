/* ============================================================================
 * js/studio-look.js —— 「渲染外观」面板（材质 · 色泽 · 光线）
 *
 * ★ 2026-11-08 21:00 的重要修正（用户原话）：
 *   「赋予这个**成片预览视图（不是全局）**材质色泽光线什么的」
 *
 * ⇒ 所以这个面板**不再改场景本身**。它只改 `window.__studioPip` 里那份
 *   "外观"，由成片预览在渲染那一刻临时套上去（见 js/real-look.js）。
 *   好处：
 *     · 主视口继续是白膜 —— 改模型时本来就该看形体，不该被材质颜色干扰
 *     · 调外观不会污染场景存档（预设/分享链接里存的是场景，不是外观）
 *     · 预览里怎么调都行，主视口干干净净
 * ========================================================================== */
import { REAL_LOOK_PRESETS, fetchHdriList } from './real-look.js?v=76';

const $ = (s, r) => (r || document).querySelector(s);
const pip = () => window.__studioPip || null;

let panel = null;

/* ── 面板 ─────────────────────────────────────────────────────────────── */

function buildPanel() {
  if (panel && document.body.contains(panel)) return panel;
  const el = document.createElement('div');
  el.id = 'lookPanel';
  el.className = 'look-panel';
  el.hidden = true;
  el.innerHTML = `
    <header class="lk-head">
      <b>成片预览 · 外观</b>
      <span class="lk-sub">只改这个小窗，主视口不变</span>
      <button type="button" class="lk-x" data-lk="close">✕</button>
    </header>
    <div class="lk-body">
      <div class="lk-group">
        <div class="lk-label">外观预设</div>
        <div class="lk-presets" id="lkPresets"></div>
        <label class="lk-check"><input type="checkbox" id="lkRealOn" checked> 开启真实感（成片预览）</label>
      </div>

      <div class="lk-group">
        <div class="lk-label">HDRI 环境光 <span class="lk-hint">本地素材库 · Poly Haven CC0</span></div>
        <div class="lk-hdri" id="lkHdri"></div>
        <label class="lk-check"><input type="checkbox" id="lkHdriBg" checked> HDRI 也当背景（室内场景建议关掉）</label>
        <div class="lk-hdri-note" id="lkHdriNote">HDRI 负责<b>环境反射</b>和<b>间接光</b> —— 金属/水/玻璃立刻像真的，阴影不再是死黑。</div>
      </div>

      <div class="lk-group">
        <div class="lk-label">真实 PBR 贴图 <span class="lk-hint">本地素材库 · ambientCG CC0</span></div>
        <label class="lk-check"><input type="checkbox" id="lkPbr"> 给地面/墙面/路面贴**真实照片**贴图（不是程序化假纹理）</label>
        <div class="lk-pbr" id="lkPbrRoles"></div>
        <div class="lk-hdri-note">这些是<b>真实扫描的 PBR 材质</b>（颜色 / 法线 / 粗糙度），
          已下载到本地 <code>素材库/PBR/</code>，离线可用、CC0 无署名要求。</div>
      </div>

      <div class="lk-group">
        <div class="lk-label">程序化材质 <span class="lk-hint">三平面投影 · 不需要 UV</span></div>
        <label class="lk-check"><input type="checkbox" id="lkProc"> 给地面/墙面/路面贴程序化材质（砖墙/木纹/草地/沥青）</label>
        <div class="lk-hdri-note">项目里的几何体基本没有 UV，所以用<b>世界坐标三平面投影</b>：
          按角色自动配砖墙 / 木地板 / 草地 / 沥青 / 混凝土。零下载、零版权、不会拉花。</div>
      </div>

      <div class="lk-group">
        <div class="lk-label">天空</div>
        <label class="lk-row"><span>天顶</span><input type="color" id="lkSkyTop" value="#3f7fd0"></label>
        <label class="lk-row"><span>地平线</span><input type="color" id="lkSkyBot" value="#f2e8d6"></label>
      </div>

      <div class="lk-group">
        <div class="lk-label">材质</div>
        <label class="lk-row"><span>粗糙度</span><input type="range" id="lkRough" min="0" max="1" step="0.02" value="0.78"><b id="lkRoughV">0.78</b></label>
        <label class="lk-row"><span>金属度</span><input type="range" id="lkMetal" min="0" max="1" step="0.02" value="0.04"><b id="lkMetalV">0.04</b></label>
        <label class="lk-check"><input type="checkbox" id="lkUseColor"> 全部统一用一个颜色</label>
        <label class="lk-row"><span>统一色</span><input type="color" id="lkColor" value="#d9d4c8"></label>
      </div>

      <div class="lk-group">
        <div class="lk-label">色泽</div>
        <label class="lk-row"><span>饱和</span><input type="range" id="lkSat" min="0" max="2" step="0.02" value="1.22"><b id="lkSatV">1.22</b></label>
        <label class="lk-row"><span>鲜艳</span><input type="range" id="lkVib" min="0" max="1" step="0.02" value="0.35"><b id="lkVibV">0.35</b></label>
        <label class="lk-row"><span>对比</span><input type="range" id="lkCon" min="0.5" max="1.8" step="0.02" value="1.06"><b id="lkConV">1.06</b></label>
        <label class="lk-row"><span>暖冷</span><input type="range" id="lkWarm" min="-0.3" max="0.3" step="0.01" value="0.06"><b id="lkWarmV">+0.06</b></label>
        <label class="lk-row"><span>暗角</span><input type="range" id="lkVig" min="0" max="1" step="0.02" value="0.22"><b id="lkVigV">0.22</b></label>
        <label class="lk-row"><span>曝光</span><input type="range" id="lkExp" min="0.5" max="2" step="0.02" value="1.05"><b id="lkExpV">1.05</b></label>
      </div>

      <div class="lk-group">
        <div class="lk-label">光线</div>
        <label class="lk-row"><span>太阳强度</span><input type="range" id="lkInt" min="0" max="4" step="0.05" value="2"><b id="lkIntV">2.00</b></label>
        <label class="lk-row"><span>太阳色</span><input type="color" id="lkSunCol" value="#fff2dc"></label>
        <label class="lk-row"><span>天光强度</span><input type="range" id="lkHemi" min="0" max="2.5" step="0.05" value="0.9"><b id="lkHemiV">0.90</b></label>
        <label class="lk-row"><span>天光色</span><input type="color" id="lkSkyCol" value="#9cc2e6"></label>
      </div>

      <div class="lk-foot">
        <button type="button" class="btn" data-lk="apply">套用到预览</button>
        <button type="button" class="btn ghost" data-lk="reset">回到默认</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  wire(el);
  panel = el;
  return el;
}

function paintPresets(cur) {
  const box = $('#lkPresets', panel);
  if (!box) return;
  box.innerHTML = REAL_LOOK_PRESETS.map((p) =>
    `<button type="button" class="lk-preset${cur === p.id ? ' on' : ''}" data-preset="${p.id}">${p.name}</button>`).join('');
}

/* ── HDRI 列表（带缩略图） ──────────────────────────────────────────── */
let hdriItems = null;
let hdriLoaded = false;

async function paintHdri(cur) {
  const box = $('#lkHdri', panel);
  if (!box) return;
  if (!hdriLoaded) {
    box.innerHTML = '<div class="lk-hdri-loading">读素材库…</div>';
    hdriItems = await fetchHdriList();
    hdriLoaded = true;
    const note = $('#lkHdriNote', panel);
    if (note) {
      note.innerHTML = hdriItems.length
        ? `HDRI 负责<b>环境反射</b>和<b>间接光</b> —— 金属/水/玻璃立刻像真的，阴影不再是死黑。
           素材库在 <code>素材库\\HDRI\\</code>（Poly Haven <b>CC0</b>，商用自用都行）。`
        : '素材库里还没有 HDRI。跑一次 <code>node tools/fetch-hdri.mjs</code> 就能下载（Poly Haven CC0，约 17MB）。';
    }
  }
  const list = hdriItems || [];
  const thumbUrl = (id) => 'http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/hdri/thumb/' + encodeURIComponent(id);
  box.innerHTML = `
    <button type="button" class="lk-hdri-item${!cur ? ' on' : ''}" data-hdri="">
      <span class="lk-hdri-thumb none">无</span><span class="lk-hdri-name">程序化天空</span>
    </button>` + list.map((h) => `
    <button type="button" class="lk-hdri-item${cur === h.id ? ' on' : ''}" data-hdri="${h.id}" title="${h.name} · ${h.license}">
      <img class="lk-hdri-thumb" src="${thumbUrl(h.id)}" alt="">
      <span class="lk-hdri-name">${h.slotLabel || h.name}</span>
    </button>`).join('');
}

function readPanel() {
  const P = panel;
  const v = (id) => { const e = $(id, P); return e ? e.value : undefined; };
  const n = (id) => Number(v(id));
  const ck = (id) => { const e = $(id, P); return e ? e.checked : false; };
  return {
    sky: { top: v('#lkSkyTop'), bottom: v('#lkSkyBot') },
    light: {
      intensity: n('#lkInt'),
      color: v('#lkSunCol'),
      hemi: n('#lkHemi'),
      skyColor: v('#lkSkyCol'),
    },
    material: {
      roughness: n('#lkRough'),
      metalness: n('#lkMetal'),
      useColor: ck('#lkUseColor'),
      color: v('#lkColor'),
    },
    grade: {
      saturation: n('#lkSat'),
      vibrance: n('#lkVib'),
      contrast: n('#lkCon'),
      warm: n('#lkWarm'),
      vignette: n('#lkVig'),
    },
    exposure: n('#lkExp'),
    hdriBg: ck('#lkHdriBg'),
    proc: { on: ck('#lkProc') },
    // ★ PBR：开没开 + 每个部位用哪个材质
    pbr: { on: ck('#lkPbr'), map: readPbrMap() },
  };
}

/** 读 PBR 部位 → 材质 id 的映射 */
function readPbrMap() {
  const P = panel;
  const out = {};
  const sels = P.querySelectorAll('select[data-pbr-role]');
  for (const s of sels) if (s.value) out[s.dataset.pbrRole] = s.value;
  return out;
}

/* ── PBR 材质选择器（按部位分组） ─────────────────────────────────────── */
const PBR_ROLE_LABEL = {
  wall: '墙', road: '路', ground: '地面', floor: '地板',
  roof: '屋顶', building: '楼体', neutral: '其他',
};
let pbrItems = null;
let pbrLoaded = false;

async function paintPbr(curMap) {
  const box = $('#lkPbrRoles', panel);
  if (!box) return;
  if (!pbrLoaded) {
    box.innerHTML = '<div class="lk-hdri-loading">读素材库…</div>';
    try {
      const mod = await import('./pbr-mat.js?v=76');
      pbrItems = await mod.pbrList();
    } catch (_) { pbrItems = []; }
    pbrLoaded = true;
  }
  const list = pbrItems || [];
  if (!list.length) {
    box.innerHTML = '<div class="lk-hdri-note">本地还没有 PBR 素材。跑一次 '
      + '<code>node tools/fetch-pbr.mjs</code> 下载（ambientCG <b>CC0</b>）。</div>';
    return;
  }
  // 按 role 分组
  const byRole = {};
  for (const it of list) (byRole[it.role || 'neutral'] = byRole[it.role || 'neutral'] || []).push(it);
  const rows = Object.keys(byRole).sort().map((role) => {
    const opts = byRole[role].map((it) => {
      const sel = (curMap && curMap[role] === it.id) ? ' selected' : '';
      return `<option value="${it.id}"${sel}>${it.label || it.name}</option>`;
    }).join('');
    const cur = (curMap && curMap[role]) || (byRole[role][0] && byRole[role][0].id);
    const opts2 = `<option value=""${cur ? '' : ' selected'}>自动</option>` + opts;
    return `<label class="lk-row lk-pbr-row"><span>${PBR_ROLE_LABEL[role] || role}</span>`
      + `<select data-pbr-role="${role}">${opts2}</select></label>`;
  }).join('');
  box.innerHTML = rows;
}

function fillPanel(look) {
  const P = panel;
  const set = (id, val) => { const e = $(id, P); if (e && val !== undefined && val !== null) e.value = String(val); };
  set('#lkSkyTop', look.sky && look.sky.top);
  set('#lkSkyBot', look.sky && look.sky.bottom);
  set('#lkRough', look.material && look.material.roughness);
  set('#lkMetal', look.material && look.material.metalness);
  const uc = $('#lkUseColor', P); if (uc) uc.checked = !!(look.material && look.material.useColor);
  set('#lkColor', look.material && look.material.color);
  set('#lkSat', look.grade && look.grade.saturation);
  set('#lkVib', look.grade && look.grade.vibrance);
  set('#lkCon', look.grade && look.grade.contrast);
  set('#lkWarm', look.grade && look.grade.warm);
  set('#lkVig', look.grade && look.grade.vignette);
  set('#lkExp', look.exposure);
  set('#lkInt', look.light && look.light.intensity);
  set('#lkSunCol', look.light && look.light.color);
  set('#lkHemi', look.light && look.light.hemi);
  set('#lkSkyCol', look.light && look.light.skyColor);
  const ro = $('#lkRealOn', P); if (ro) ro.checked = !!(pip() && pip().getReal());
  const hb = $('#lkHdriBg', P); if (hb) hb.checked = look.hdriBg !== false;
  const pr = $('#lkProc', P); if (pr) pr.checked = !!(look.proc && look.proc.on);
  const pb = $('#lkPbr', P); if (pb) pb.checked = !!(look.pbr && look.pbr.on);
  paintPbr(look.pbr && look.pbr.map);
  syncLabels();
}

function syncLabels() {
  const P = panel;
  const set = (id, v) => { const e = $(id, P); if (e) e.textContent = v; };
  const n = (id) => Number($(id, P).value);
  set('#lkRoughV', n('#lkRough').toFixed(2));
  set('#lkMetalV', n('#lkMetal').toFixed(2));
  set('#lkSatV', n('#lkSat').toFixed(2));
  set('#lkVibV', n('#lkVib').toFixed(2));
  set('#lkConV', n('#lkCon').toFixed(2));
  set('#lkWarmV', (n('#lkWarm') >= 0 ? '+' : '') + n('#lkWarm').toFixed(2));
  set('#lkVigV', n('#lkVig').toFixed(2));
  set('#lkExpV', n('#lkExp').toFixed(2));
  set('#lkIntV', n('#lkInt').toFixed(2));
  set('#lkHemiV', n('#lkHemi').toFixed(2));
}

/** 把面板的值推给预览（只推给 PIP，不碰场景） */
function push() {
  const p = pip();
  if (!p) return;
  const look = readPanel();
  p.setLook(look);
  // ★ PBR 贴图要**先下载/解码**才能用（applyRealLook 是同步的）
  //   所以这里异步准备，准备好了再推一次。
  if (look.pbr && look.pbr.on) {
    const mod = window.__ovfRealLook;
    if (mod && mod.preparePbr) {
      mod.preparePbr(look.pbr.map).then((sets) => {
        if (!sets) return;
        p.setLook({ pbr: { on: true, map: look.pbr.map } });
        if (p.refresh) p.refresh();
      }).catch(() => {});
    }
  }
}

function wire(el) {
  el.addEventListener('click', async (ev) => {
    // HDRI 选择
    const hd = ev.target.closest('[data-hdri]');
    if (hd) {
      const id = hd.dataset.hdri || null;
      const p = pip();
      if (p && p.setHdri) {
        const r = await p.setHdri(id);
        if (!r.ok) { /* 加载失败也别打断，面板继续可用 */ }
      }
      paintHdri(id);
      return;
    }
    const b = ev.target.closest('[data-lk],[data-preset]');
    if (!b) return;
    if (b.dataset.lk === 'close') { el.hidden = true; return; }
    if (b.dataset.lk === 'apply') { push(); return; }
    if (b.dataset.lk === 'reset') {
      const p = pip();
      if (p && p.setPreset) { p.setPreset('daylight'); fillPanel(p.getLook()); paintPresets('daylight'); paintHdri(p.getLook().hdri); }
      return;
    }
    if (b.dataset.preset) {
      const p = pip();
      if (!p || !p.setPreset) return;
      p.setPreset(b.dataset.preset);
      fillPanel(p.getLook());
      paintPresets(b.dataset.preset);
    }
  });
  // 滑杆拖动 → 实时推给预览
  el.addEventListener('input', () => {
    syncLabels();
    push();
  });
  el.addEventListener('change', () => { syncLabels(); push(); });
}

/** 打开面板 */
export function openLookPanel() {
  const el = buildPanel();
  el.hidden = false;
  const p = pip();
  if (p) { fillPanel(p.getLook()); paintPresets(p.getLook().preset); paintHdri(p.getLook().hdri); }
  return el;
}

window.__openLookPanel = openLookPanel;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => {}, { once: true });
else { /* PIP 会自己准备好 */ }
