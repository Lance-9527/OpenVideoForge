/* ============================================================================
 * js/studio-city.js —— 「调出真实城市」（城市名 → OSM 真实街区）
 *
 * ★ 2026-11-10：用户要"任意选一个城市都能调出来并在场景中复刻"。
 *   之前只有 wb_world_build(lat,lng,radius) —— 得自己查经纬度，
 *   界面上也没有入口。现在：输城市名就行。
 *
 * 流程：
 *   入口页卡片「调出真实城市」→ 弹层
 *     · 输入城市名（本地表即时建议 + Nominatim 兜底）
 *     · 选抓取半径（200/300/500/1000 m）
 *     · 点「抓取」→ 服务端 Overpass 抓 OSM + 地形高程 → 页面建几何 → 进编辑器
 * ========================================================================== */
import * as THREE from 'three';

const BRIDGE = () => 'http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787);

let overlay = null;
let busy = false;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, kind = '', ms = 3200) {
  try { window.__ovfToast ? window.__ovfToast(msg, kind, ms) : null; } catch (_) {}
  const box = document.querySelector('#toastBox') || document.body;
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

/** 打开弹层 */
export function openCityPicker() {
  if (overlay && document.body.contains(overlay)) return overlay;
  const el = document.createElement('div');
  el.id = 'cityPicker';
  el.className = 'city-picker';
  el.innerHTML = `
    <div class="cp-box">
      <header class="cp-head">
        <b>调出真实城市</b>
        <button type="button" class="cp-x" title="关闭">×</button>
      </header>
      <div class="cp-body">
        <label class="cp-label">城市名（中文或英文都行）</label>
        <div class="cp-search">
          <input type="text" id="cpQuery" placeholder="比如：京都 / Reykjavik / 雷克雅未克" autocomplete="off">
          <button type="button" class="btn" id="cpSearch">查</button>
        </div>
        <div class="cp-sugg" id="cpSugg"></div>
        <div class="cp-picked" id="cpPicked"></div>
        <label class="cp-label">抓取范围</label>
        <div class="cp-radii" id="cpRadii">
          ${[
            [300, '300m', '街区'],
            [600, '600m', '片区'],
            [1200, '1.2km', '城区'],
            [2500, '2.5km', '整个区'],
          ].map(([r, label, hint], i) => `
            <button type="button" class="cp-radius${i === 1 ? ' on' : ''}" data-r="${r}" title="${hint}">${label}</button>`).join('')}
        </div>
        <p class="cp-hint">抓的是 OpenStreetMap 真实街区数据 + 地形高程（© OpenStreetMap contributors）。
        范围越大楼越多（2.5km 能覆盖整个行政区），但首次抓取要 1~2 分钟，之后走本地缓存。</p>
      </div>
      <footer class="cp-foot">
        <span class="cp-status" id="cpStatus"></span>
        <button type="button" class="btn ghost" id="cpCancel">取消</button>
        <button type="button" class="btn primary" id="cpGo" disabled>抓取并进场景</button>
      </footer>
    </div>`;
  document.body.appendChild(el);
  overlay = el;

  const q = el.querySelector('#cpQuery');
  const sugg = el.querySelector('#cpSugg');
  const picked = el.querySelector('#cpPicked');
  const status = el.querySelector('#cpStatus');
  const go = el.querySelector('#cpGo');
  let city = null;
  let radius = 300;

  const setStatus = (s, kind = '') => { status.textContent = s; status.className = 'cp-status ' + kind; };

  const showPicked = () => {
    if (!city) { picked.innerHTML = ''; go.disabled = true; return; }
    picked.innerHTML = `<b>${esc(city.name)}</b>${city.country ? ' · ' + esc(city.country) : ''}
      <span class="cp-coord">${city.lat}, ${city.lng}（${city.source === 'local' ? '本地城市表' : 'Nominatim'}）</span>`;
    go.disabled = false;
  };

  const renderSugg = (items) => {
    if (!items || !items.length) { sugg.innerHTML = ''; return; }
    sugg.innerHTML = items.map((c) => `
      <button type="button" class="cp-sugg-item" data-lat="${c.lat}" data-lng="${c.lng}"
        data-name="${esc(c.name)}" data-country="${esc(c.country || '')}" data-en="${esc(c.en || '')}">
        <b>${esc(c.name)}</b><i>${esc(c.en || '')}</i>
      </button>`).join('');
  };

  const localSuggest = async (text) => {
    try {
      const r = await fetch(`${BRIDGE()}/cities?q=${encodeURIComponent(text)}`);
      const j = await r.json();
      renderSugg(j.items || []);
    } catch (_) { /* 桥没起就静默 */ }
  };

  const doSearch = async () => {
    const text = q.value.trim();
    if (!text) { setStatus('先输个城市名', 'warn'); return; }
    setStatus('查…');
    try {
      const r = await fetch(`${BRIDGE()}/geocode?q=${encodeURIComponent(text)}`);
      const j = await r.json();
      if (j.ok && j.city) {
        city = j.city;
        showPicked();
        setStatus('✓ 找到了', 'ok');
        renderSugg(j.candidates || []);
      } else {
        city = null; showPicked();
        setStatus(j.error || '没找到', 'warn');
        renderSugg(j.candidates || []);
      }
    } catch (e) {
      city = null; showPicked();
      setStatus('连不上本地服务（桥没起？）', 'warn');
    }
  };

  q.addEventListener('input', () => { localSuggest(q.value.trim()); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  el.querySelector('#cpSearch').addEventListener('click', doSearch);

  sugg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lat]');
    if (!b) return;
    city = {
      name: b.dataset.name, en: b.dataset.en, country: b.dataset.country,
      lat: +b.dataset.lat, lng: +b.dataset.lng, source: 'local',
    };
    q.value = city.name;
    showPicked();
    setStatus('✓ 选好了', 'ok');
  });

  el.querySelector('#cpRadii').addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    radius = +b.dataset.r;
    el.querySelectorAll('.cp-radius').forEach((x) => x.classList.toggle('on', x === b));
  });

  el.querySelector('#cpCancel').addEventListener('click', close);
  el.querySelector('.cp-x').addEventListener('click', close);

  go.addEventListener('click', async () => {
    if (!city || busy) return;
    busy = true;
    go.disabled = true;
    setStatus('抓取中…（Overpass 拉数据 + 地形高程）', 'run');
    try {
      // ★ wb_world_build 是**服务端工具**（要跑 Overpass 抓取）⇒ 走桥的 /tool，
      //   不是页面指令。
      const res = await fetch(`${BRIDGE()}/tool`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'wb_world_build',
          // ★ 2026-11-10：把**城市名**传下去 ⇒ 入口页「继续上次：上海黄浦区」
          args: { kind: 'osm', lat: city.lat, lng: city.lng, radius, name: city.name },
        }),
      });
      const jb = await res.json();
      // ★ 2026-11-10：**桥的 /tool 返回是顶层结构**（{ok,key,url,stats,page,terrain}），
      //   没有 data 包装 —— 之前读 jb.data ⇒ 拿到 undefined ⇒ "缺少 url" ⇒
      //   面板显示"建场景失败"（实测）。
      const resData = (jb && jb.data) || jb || {};
      if (!jb || !jb.ok) {
        setStatus('抓取失败：' + ((jb && jb.error) || '未知错误'), 'warn');
        busy = false; go.disabled = false;
        return;
      }
      setStatus('✓ 抓到了，正在建场景…', 'ok');
      // ★ 桥在服务端流程里**已经调页面侧建好几何了**（pageCall('world.osm')），
      //   所以这里通常不用再建一次；只有桥那边失败才自己补一次。
      let built = !!(jb.page && jb.page.ok === true);
      if (!built) {
        const r2 = await window.WB_AGENT.run('world.osm', {
          url: resData.url, attribution: resData.attribution,
        });
        built = !!(r2 && r2.ok);
        if (!built) {
          setStatus('建场景失败：' + ((r2 && r2.error) || '未知错误'), 'warn');
          busy = false; go.disabled = false;
          return;
        }
      }
      // 存一份场景记录（这样能在「我的场景」里再调出来）
      try {
        const rec = {
          id: 'osm_' + Date.now().toString(36),
          name: city.name + '（真实街区 ' + radius + 'm）',
          env: 'osm',
          spec: { kind: 'osm', url: resData.url, lat: city.lat, lng: city.lng, radius },
          created: Date.now(),
        };
        if (window.WBSceneImport && window.WBSceneImport.add) {
          window.WBSceneImport.add(Object.assign({ title: rec.name, type: 'native' }, rec));
        } else if (window.__ovfSaveScene) {
          window.__ovfSaveScene(rec);
        }
      } catch (_) {}
      // ★ 2026-11-10：记下"上次的地方"（带**城市名**，重启后入口显示「继续上次：上海黄浦区」）
      try {
        if (window.__ovfLastWorld) {
          window.__ovfLastWorld.rememberWorld({
            lat: city.lat, lng: city.lng, radius, name: city.name,
            attribution: resData.attribution,
          });
        }
      } catch (_) {}
      close();
      toast('已调出「' + city.name + '」真实街区', 'ok', 4000);
    } catch (e) {
      setStatus('出错：' + String((e && e.message) || e), 'warn');
    } finally {
      busy = false;
      go.disabled = false;
    }
  });

  setTimeout(() => { q.focus(); localSuggest(''); }, 60);
  return el;
}

export function close() {
  if (overlay && document.body.contains(overlay)) overlay.remove();
  overlay = null;
}

/* ── 接线：入口页那张卡片 ─────────────────────────────────────────── */
export function initCityPicker() {
  const card = document.getElementById('enCardCity');
  if (card && !card.dataset.wired) {
    card.dataset.wired = '1';
    card.addEventListener('click', () => openCityPicker());
  }
}

window.__ovfCity = { open: openCityPicker, close };
