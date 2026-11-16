/* ==========================================================================
 * studio-agent.js · 指令总线 + 右侧「AI 指令」面板 + 本地 Agent 桥客户端（v1.0）
 *
 * 产品形态：**AI 操作 + 用户操作** 并存。
 *   1) 页面内暴露 window.WB_AGENT.run(name, args) —— 所有能力都是具名指令，返回结构化结果；
 *   2) 右最侧一个「AI 指令」窗：人可以直接打字（内置中英文关键词解析），也看得到反馈；
 *   3) 连上本地 Agent 桥（server/agent-bridge.mjs）后，外部 Agent（MCP / HTTP）发来的指令
 *      走同一条总线执行，结果原路返回。桥不在线时面板照常可用（纯本地）。
 *
 * 指令清单见 docs/AGENT-PROTOCOL.md。
 * ========================================================================== */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ed = () => (window.__wb && window.__wb.editor) || null;
const tlm = () => (window.__wb && window.__wb.timeline) || null;
const bridgeUrl = () => `http://127.0.0.1:${(window.WB_BRIDGE_PORT || 8787)}`;

/* ------------------------------------------------------------ */
/* 指令实现                                                      */
/* ------------------------------------------------------------ */
function selectedRec(e) {
  return e && e.selected ? e.selected : null;
}

function findAssetByText(text) {
  const list = window.WB_ASSETS || [];
  const t = String(text || '').trim();
  if (!t) return null;
  return list.find(a => a.name === t)
    || list.find(a => t.includes(a.name) || a.name.includes(t))
    || null;
}

const COMMANDS = {
  'client.identify': () => ({
    href: location.href,
    view: window.__wb && window.__wb.view,
    hasEditor: !!(window.__wb && window.__wb.editor),
    stamp: (window.__stamp || (window.__stamp = Math.random().toString(36).slice(2))),
    visibility: document.visibilityState,
  }),

  'state.get': () => {
    const e = ed();
    const t = tlm();
    return {
      view: window.__wb && window.__wb.view,
      env: e ? e.envId : null,
      objects: e ? e.objects.length : 0,
      coordinates: 'THREE_Y_UP_METERS',
      scene_id: (ed() && ed().studioSceneId) || null,
      revision: (ed() && ed().studioRevision != null) ? ed().studioRevision : null,
      instances: e ? e.objects.map(o => ({ instanceId: o.instanceId, assetId: o.assetId, externalAssetId: o.externalAsset?.id || null,
        position: o.group.position.toArray(), quaternion: o.group.quaternion.toArray(), scale: o.group.scale.toArray() })) : [],
      selected: e && e.selected ? { instanceId: e.selected.instanceId, assetId: e.selected.assetId, pos: e.selected.group.position.toArray().map(n => +n.toFixed(2)) } : null,
      light: e && e.getLight ? e.getLight() : null,
      grade: e && e.getColorGrade ? e.getColorGrade() : null,
      shots: t ? t.getShots().map(s => ({ id: s.id, label: s.label, duration: s.duration })) : [],
      total: t ? t.totalDuration() : 0,
      dragMode: e ? e.dragMode : null,
      snap: e ? !!e.snap : false,
      env_size: e ? (e.envSize || 'small') : null,     // 场地尺寸档位
      agent_scene: currentSceneKey,                     // 当前会话桶（一个场景一个框）
    };
  },

  'env.load': ({ env, size }) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    // size = 场地尺寸档位（small/medium/large）：地图大小是设置，不是写死
    e.loadEnv(env || 'room', { size: size || e.envSize });
    const badge = $('#edEnvBadge');
    const found = (window.WB_ENVIRONMENTS || []).find(x => x.id === env);
    if (badge && found) badge.textContent = found.name;
    return { env: e.envId, size: e.envSize };
  },

  // 换场地大小（用户：「地图大小可以再拓一下…如果需要小场景，设置就行」）
  'env.size': ({ size }) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    if (!size) {
      const ids = Object.keys(window.WB_SCENE_SIZES || {}).join('/') || 'small/medium/large';
      return { error: '缺少 size（' + ids + '）', size: e.envSize };
    }
    const r = e.setEnvSize(size);
    return { size: r.size, factor: r.factor };
  },

  // ★ 2026-11-08：生成型世界（程序化城市 / 未来的 OSM 真实街区）。
  //   设计口径：世界放大**不改物件尺寸**，只增加数量（见 worldgen/plan.js）。
  'world.info': () => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    return e.worldInfo ? e.worldInfo() : { env: e.envId, world: null };
  },

  'world.build': ({ kind, seed, density, size }) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    const envId = kind || 'city';
    const found = (window.WB_ENVIRONMENTS || []).find((x) => x.id === envId);
    if (!found) {
      return {
        error: '未知世界类型：' + envId,
        available: (window.WB_ENVIRONMENTS || []).map((x) => x.id),
      };
    }
    if (window.__studioTopbar && window.__studioTopbar.checkpoint) window.__studioTopbar.checkpoint();
    if (size) e.setEnvSize(size);
    e.loadEnv(envId, { size: size || e.envSize, seed, density });
    // ★ 2026-11-08：记下生成参数，预设才能"照原样调出来"
    e._worldSpec = {
      kind: 'env', env: envId,
      size: size || e.envSize,
      seed: seed == null ? null : Number(seed),
      density: density == null ? null : Number(density),
    };
    const badge = $('#edEnvBadge');
    if (badge) badge.textContent = found.name;
    // ★ 右侧面板要跟着刷新（否则「场地大小」还写着旧档位）
    if (window.__studioInspector && window.__studioInspector.syncPanels) window.__studioInspector.syncPanels();
    return { ok: true, ...(e.worldInfo ? e.worldInfo() : { env: e.envId }) };
  },

  // ★ 2026-11-08：页面侧的 OSM 装载。数据由服务端抓好并落盘（server/osm.mjs），
  //   这里只按 URL 拉取 + 建几何 —— 因为几何必须在浏览器里建（three 在页面侧）。
  'world.osm': async ({ url, attribution, terrain, terrainStats, name }) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    if (!e.loadOsmWorld) return { error: '当前编辑器不支持真实世界' };
    if (!url) return { error: '缺少 url' };
    try {
      // ★ 2026-11-08：**要把地形网格一起传下去**，否则地面还是平的
      const info = await e.loadOsmWorld({ url, attribution, terrain, terrainStats });
      const badge = $('#edEnvBadge');
      if (badge) badge.textContent = '真实世界';
      // ★ 右侧面板跟着刷新（「场地大小」要显示最接近的档位，而不是旧的小场景）
      if (window.__studioInspector && window.__studioInspector.syncPanels) window.__studioInspector.syncPanels();
      // ★ 2026-11-10：**记下"上次的地方"** ⇒ 关掉再打开还是这里（用户反馈：打开却是空房间）。
      //   URL 里带 key（lat_lng_radius），直接解析出来。
      try {
        const m = /\/osm\/world\/([-\d.]+)_([-\d.]+)_(\d+)\.json/.exec(String(url || ''));
        if (m && window.__ovfLastWorld) {
          window.__ovfLastWorld.rememberWorld({
            lat: +m[1], lng: +m[2], radius: +m[3],
            name: name || (e._citySpec && e._citySpec.name) || (e.osmCityName) || null,
            attribution: e.osmAttribution || attribution,
          });
        }
      } catch (_) { /* 记不住不影响主流程 */ }
      return { ok: true, ...info, attribution: e.osmAttribution || attribution };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },

  // ★ 2026-11-08：**进到楼里**。室内是在原楼里"加一层壳"，不是挖洞
  //   （OSM 的楼是几千栋合并成一个几何，挖孔要重三角化整片街区）。
  'building.enter': ({ x, z, index, maxDist, floor }) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    if (!e.enterBuilding) return { error: '当前编辑器不支持进屋' };
    try {
      return e.enterBuilding({ x, z, index, maxDist, floor });
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },

  // ★ 2026-11-08：多层室内换层
  // ★ 2026-11-10：floor = -1 ⇒ **总览模式**（一次看全部楼层）
  'building.floor': ({ floor } = {}) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    if (!e.changeFloor) return { error: '当前编辑器不支持换层' };
    try {
      const f = Number(floor);
      if (f === -1) return e.enterBuilding({ building: e._interior.source, floor: -1 });
      return e.changeFloor(floor || 0);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },

  // ★ 2026-11-10：**室内总览**（一次画出全部楼层，站在楼外俯瞰）
  'building.overview': () => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    if (!e._interior || !e._interior.source) return { error: '当前不在室内' };
    try {
      return e.enterBuilding({ building: e._interior.source, floor: -1 });
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },

  'building.exit': () => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    return e.exitBuilding ? e.exitBuilding() : { ok: false, error: '不支持' };
  },

  'building.info': () => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    return e.interiorInfo ? e.interiorInfo() : { inside: false };
  },

  'building.list': ({ limit } = {}) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    if (!e.buildingList) return { error: '当前编辑器不支持楼列表' };
    return e.buildingList(limit || 60);
  },

  // ★ 2026-11-08：材质 / 灯光的捕获与复用（配合资产库）
  'material.capture': () => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    return e.captureMaterial ? e.captureMaterial() : { error: '不支持' };
  },

  'material.apply': ({ material, all } = {}) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    if (!e.applyMaterial) return { error: '不支持' };
    return e.applyMaterial(material, { all: !!all });
  },

  'light.capture': () => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    return e.captureLight ? e.captureLight() : { error: '不支持' };
  },

  'light.apply': ({ light } = {}) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    if (!e.applyLightPreset) return { error: '不支持' };
    return e.applyLightPreset(light);
  },

  // ★ 2026-11-08：把资产库里的模型放进当前场景（GLB 从桥直接吃）
  'library.place': async ({ id } = {}) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    if (!id) return { error: '缺少 id' };
    const url = 'http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/library/file/' + encodeURIComponent(id);
    try {
      if (!e.addExternalAsset) return { error: '当前编辑器不支持外部模型' };
      const rec = await e.addExternalAsset({ id, name: id, file_url: url });
      return { ok: true, instanceId: rec && rec.instanceId, assetId: rec && rec.assetId };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },

  // ★ 2026-11-08：**拖拉拽放置**。资产库里的模型点一下 → 进入放置模式
  //   （物体跟鼠标走，左键放下，Esc 取消）。
  'library.place.begin': async ({ id } = {}) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    if (!id) return { error: '缺少 id' };
    const url = 'http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/library/file/' + encodeURIComponent(id);
    try {
      if (!e.beginPlaceExternal) return { error: '当前编辑器不支持拖拉拽放置' };
      const rec = await e.beginPlaceExternal({ id, name: id, file_url: url });
      return { ok: true, instanceId: rec && rec.instanceId, assetId: rec && rec.assetId, placing: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  },

  // ★ 2026-11-08：内置资产也走拖拉拽放置（点一下 → 物体跟鼠标 → 左键放下）
  'place.begin': ({ asset } = {}) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    if (!asset) return { error: '缺少 asset' };
    if (!e.beginPlace) return { error: '当前编辑器不支持拖拉拽放置' };
    const rec = e.beginPlace(asset);
    if (!rec) return { error: '找不到资产：' + asset };
    return { ok: true, instanceId: rec.instanceId, assetId: rec.assetId, placing: true };
  },

  'place.end': ({ commit } = {}) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    return { ok: true, placed: e.endPlace ? e.endPlace(commit !== false) : false };
  },

  'asset.add': ({ asset, id, x, y, z, ry, scale }) => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    let aid = id || asset;
    if (!aid || !(window.WB_ASSETS || []).some(a => a.id === aid)) {
      const found = findAssetByText(asset);
      if (!found) return { error: '找不到资产：' + String(asset) };
      aid = found.id;
    }
    if (window.__studioTopbar && window.__studioTopbar.checkpoint) window.__studioTopbar.checkpoint();
    e.addAsset(aid);
    const rec = e.objects[e.objects.length - 1];
    if (!rec) return { error: '添加失败' };
    if ([x, y, z].some(v => typeof v === 'number')) {
      rec.group.position.set(Number(x) || 0, Number(y) || 0, Number(z) || 0);
    }
    if (typeof ry === 'number') rec.group.rotation.y = (ry * Math.PI) / 180;
    if (typeof scale === 'number') rec.group.scale.setScalar(scale);
    // v68：位置/缩放改完后再解一次重叠（上面 addAsset 里那次是在改位之前跑的）
    if (e.solveLayout) e.solveLayout({ movers: [rec.instanceId], clearance: 0.02 });
    e.select(rec);
    return { instanceId: rec.instanceId, assetId: aid, pos: rec.group.position.toArray().map(n => +n.toFixed(2)) };
  },

  'asset.delete': () => {
    const e = ed();
    if (!e) return { error: '请先打开一个场景' };
    if (!selectedRec(e)) return { error: '没有选中的对象' };
    if (window.__studioTopbar && window.__studioTopbar.checkpoint) window.__studioTopbar.checkpoint();
    e.deleteSelected();
    return { deleted: true };
  },

  'asset.transform': ({ instanceId, x, y, z, ry, scale, quaternion }) => {
    const e = ed();
    const rec = instanceId && e ? e.objects.find(o => o.instanceId === instanceId) : selectedRec(e);
    if (!e || !rec) return { error: '没有选中的对象' };
    const g = rec.group;
    if (typeof x === 'number') g.position.x = x;
    if (typeof y === 'number') g.position.y = Math.max(0, y);
    if (typeof z === 'number') g.position.z = z;
    if (typeof ry === 'number') g.rotation.y = (ry * Math.PI) / 180;
    if (typeof scale === 'number') g.scale.setScalar(scale);
    else if (Array.isArray(scale) && scale.length === 3) g.scale.fromArray(scale);
    if (Array.isArray(quaternion) && quaternion.length === 4) g.quaternion.fromArray(quaternion);
    e.select(rec);
    return { instanceId: rec.instanceId, pos: g.position.toArray(), quaternion: g.quaternion.toArray(), scale: g.scale.toArray() };
  },

  'asset.color': ({ color }) => {
    const e = ed();
    const rec = selectedRec(e);
    if (!e || !rec) return { error: '没有选中的对象' };
    e.setColor(color);
    return { color };
  },

  'asset.list': () => {
    const groups = {};
    (window.WB_ASSETS || []).forEach(a => {
      if (a.id === '__empty') return;
      (groups[a.cat || 'other'] = groups[a.cat || 'other'] || []).push(a.name);
    });
    return { total: (window.WB_ASSETS || []).length, groups };
  },

  'asset.drop': () => {
    const e = ed();
    const rec = selectedRec(e);
    if (!e || !rec) return { error: '没有选中的对象' };
    const r = e.dropToGround(rec);
    return r || { error: '落地失败' };
  },

  /** v68 · 去重叠：确定性布局求解（水平面 MTV 分离），不是刚体物理 */
  'scene.layout.solve': (a = {}) => {
    const e = ed();
    if (!e || !e.solveLayout) return { error: '场景未就绪' };
    return e.solveLayout(a || {});
  },

  'asset.array': ({ cols, rows, gap }) => {
    const e = ed();
    if (!e || !selectedRec(e)) return { error: '先选中一个对象再阵列' };
    const n = e.arrayDuplicate(cols, rows, gap);
    return { added: n };
  },

  'light.set': (patch) => {
    const e = ed();
    if (!e || !e.setLight) return { error: '场景未就绪' };
    return e.setLight(patch);
  },

  'light.preset': ({ name }) => {
    const e = ed();
    if (!e) return { error: '场景未就绪' };
    const presets = {
      '正午': { azimuth: 180, elevation: 70, kelvin: 5500, intensity: 1.35, shadowSoft: 0.25, hemi: 1.05, fog: true, on: true },
      '黄昏': { azimuth: 250, elevation: 12, kelvin: 2600, intensity: 1.15, shadowSoft: 0.45, hemi: 0.62, fog: true, on: true },
      '夜景': { azimuth: 300, elevation: 32, kelvin: 8200, intensity: 0.42, shadowSoft: 0.7, hemi: 0.36, fog: true, on: true },
      '影棚': { azimuth: 135, elevation: 55, kelvin: 5600, intensity: 1.0, shadowSoft: 0.9, hemi: 1.25, fog: false, on: true },
      '侧光': { azimuth: 92, elevation: 28, kelvin: 6000, intensity: 1.65, shadowSoft: 0.15, hemi: 0.42, fog: true, on: true },
    };
    const p = presets[name];
    if (!p) return { error: '未知灯光预设：' + name, available: Object.keys(presets) };
    return e.setLight(p);
  },

  'grade.set': ({ exposure, contrast, saturation, vignette, bloom, grain, letterbox, film }) => {
    const e = ed();
    if (!e) return { error: '场景未就绪' };
    if (typeof exposure === 'number' && e.setExposure) e.setExposure(exposure);
    if ([contrast, saturation, vignette].some(v => typeof v === 'number') && e.setColorGrade) {
      e.setColorGrade({ contrast, saturation, vignette });
    }
    if ([bloom, grain, letterbox].some(v => v !== undefined) || typeof film === 'boolean') {
      if (e.setFilmLook) {
        const patch = { bloom, grain };
        if (letterbox !== undefined) patch.letterbox = letterbox === 'off' ? null : letterbox;
        if (typeof film === 'boolean') patch.on = film;
        e.setFilmLook(patch);
      }
    }
    if (window.__studioInspector && window.__studioInspector.syncPanels) window.__studioInspector.syncPanels();
    if (window.__syncFilmUI) window.__syncFilmUI();
    return { grade: e.getColorGrade(), film: e.getFilmLook ? e.getFilmLook() : null };
  },

  'shot.add': ({ label, duration }) => {
    const t = tlm();
    if (!t) return { error: '请先打开场景并等待时间线就绪' };
    const s = t.addShotFromCamera();
    if (!s) return { error: '加镜头失败' };
    if (label || typeof duration === 'number') {
      t.updateShot(s.id, {
        ...(label ? { label } : {}),
        ...(typeof duration === 'number' ? { duration: Math.max(0.1, duration) } : {}),
      });
    }
    return { shot: { id: s.id, label: label || s.label, duration: duration || s.duration }, total: t.totalDuration() };
  },

  'shot.list': () => {
    const t = tlm();
    if (!t) return { shots: [] };
    let acc = 0;
    return {
      shots: t.getShots().map((s, i) => {
        const start = acc; acc += Number(s.duration) || 3;
        return { index: i, id: s.id, label: s.label, start: +start.toFixed(2), duration: s.duration };
      }),
      total: t.totalDuration(),
    };
  },

  'shot.play': () => {
    const t = tlm();
    if (!t) return { error: '时间线未就绪' };
    t.play();
    return { playing: true, total: t.totalDuration() };
  },

  'shot.preview': ({ index, id }) => {
    const t = tlm();
    if (!t) return { error: '时间线未就绪' };
    const ref = typeof index === 'number' ? index : id;
    if (ref === undefined || ref === null) return { error: '需要 index（从 0 起）或 id' };
    const r = t.previewShot(ref);
    if (!r) return { error: '没有这个镜头' };
    return { previewing: r.index, duration: r.duration, end: +r.end.toFixed(2) };
  },

  'shot.previewStop': () => {
    const t = tlm();
    if (!t) return { error: '时间线未就绪' };
    return { stopped: t.stopPreview() };
  },

  'shot.stop': () => {
    const t = tlm();
    if (!t) return { error: '时间线未就绪' };
    t.stop();
    return { playing: false };
  },

  'camera.set': ({ r, phi, theta, tx, ty, tz, fov }) => {
    const e = ed();
    if (!e) return { error: '场景未就绪' };
    if (typeof r === 'number') e.sph.r = Math.max(1, r);
    if (typeof phi === 'number') e.sph.phi = Math.max(0.05, Math.min(1.55, phi));
    if (typeof theta === 'number') e.sph.theta = theta;
    if ([tx, ty, tz].some(v => typeof v === 'number')) {
      e.target.set(tx == null ? e.target.x : tx, ty == null ? e.target.y : ty, tz == null ? e.target.z : tz);
    }
    if (typeof fov === 'number') { e.camera.fov = fov; e.camera.updateProjectionMatrix(); }
    e._applyCamera();
    return { cam: e.captureCam() };
  },

  'render': ({ w, h, returnBase64 }) => {
    const e = ed();
    if (!e) return { error: '场景未就绪' };
    const url = e.captureThumb(w || 1920, h || 1080);
    if (!returnBase64) {
      const a = document.createElement('a');
      a.href = url;
      a.download = '白膜_' + (w || 1920) + 'x' + (h || 1080) + '_' + Date.now() + '.jpg';
      a.click();
    }
    return returnBase64 ? { mime: 'image/jpeg', base64: url.split(',')[1] } : { downloaded: true, size: [w || 1920, h || 1080] };
  },

  'panorama.set': async ({ url }) => {
    const e = ed();
    if (!e || !e.setPanorama) return { error: '场景未就绪' };
    await e.setPanorama(url);
    return { panorama: url };
  },

  'dragmode.set': ({ mode }) => {
    const e = ed();
    if (!e || !e.setDragMode) return { error: '场景未就绪' };
    return { dragMode: e.setDragMode(mode) };
  },

  'scene.list': () => ({
    scenes: ((window.__wb && window.__wb.scenes) || []).map(s => ({
      id: s.id, title: s.title, shots: (s.shots || []).length, type: s.type,
    })),
  }),

  'scene.new': ({ env, size }) => {
    if (!window.__wb || !window.__wb.openEditor) return { error: '入口不可用' };
    // size：场地尺寸档位（后端设置 previz_scene_scale 会通过 wb_scene_new 传进来）
    window.__wb.openEditor({ env: env || 'room', size: size || undefined });
    return { opening: true, env: env || 'room', size: size || null };
  },

  'scene.save': ({ title }) => {
    const name = $('#edName');
    if (name && title) name.value = title;
    if (window.__wb && window.__wb.saveEditor) window.__wb.saveEditor();
    return { saved: true, title: (name && name.value) || title || null };
  },

  'scene.open': ({ id }) => {
    if (!id) return { error: '缺少 id' };
    if (window.__wb && window.__wb.openEditor) window.__wb.openEditor({ recId: id });
    return { opening: id };
  },

  'storyboard.open': () => {
    if (window.__wb && window.__wb.openEditorStoryboard) { window.__wb.openEditorStoryboard(); return { opened: true }; }
    return { error: '分镜表入口不可用' };
  },

  'video.export': async ({ w, h, fps, mode, download }) => {
    if (!window.__studioVideo) return { error: '视频模块未就绪（刷新页面）' };
    const res = await window.__studioVideo.exportVideo({
      w, h, fps, mode,
      download: download === true,          // Agent 默认不下载，只回体积/时长
    });
    if (!res.ok) return { error: res.error };
    return res;
  },

  'video.dialog': () => {
    if (!window.__studioVideo) return { error: '视频模块未就绪' };
    window.__studioVideo.openVideoDialog();
    return { opened: true };
  },

  /* --- v1.8 设备机位（手机 / 无人机） --- */
  'device.add': ({ kind, x, y, z, lookX, lookY, lookZ, aspect }) => {
    const e = ed();
    if (!e || !e.addDeviceCam) return { error: '请先打开一个场景' };
    const k = kind === 'drone' ? 'drone' : 'phone';
    const rec = e.addDeviceCam(k, { x, y, z, lookX, lookY, lookZ });
    if (!rec) return { error: '添加失败' };
    if (aspect) { rec.aspect = aspect; e.updateDevice(rec); }
    return { id: rec.id, device: rec.device, pos: rec.group.position.toArray().map(n => +n.toFixed(2)), fov: rec.cam.fov };
  },

  'device.aim': ({ id, yaw, pitch, fov, x, y, z }) => {
    const e = ed();
    if (!e || !e.setDeviceAim) return { error: '场景未就绪' };
    if (!id) {
      const first = (e.devices || [])[0];
      if (!first) return { error: '还没有设备机位' };
      id = first.id;
    }
    const r = e.setDeviceAim(id, { yaw, pitch, fov, x, y, z });
    return r || { error: '调整失败' };
  },

  'device.look': ({ id, target }) => {
    const e = ed();
    if (!e || !e.aimDeviceAt) return { error: '场景未就绪' };
    if (!id) {
      const first = (e.devices || [])[0];
      if (!first) return { error: '还没有设备机位' };
      id = first.id;
    }
    const tp = Array.isArray(target) ? { x: target[0], y: target[1], z: target[2] } : null;
    const r = e.aimDeviceAt(id, tp ? new (e.target.constructor)(tp.x, tp.y, tp.z) : undefined);
    return r || { error: '对准失败' };
  },

  'device.list': () => {
    const e = ed();
    if (!e || !e.listDevices) return { devices: [] };
    return { devices: e.listDevices() };
  },

  'device.remove': ({ id }) => {
    const e = ed();
    if (!e || !e.removeDevice) return { error: '场景未就绪' };
    return { removed: e.removeDevice(id) };
  },

  /** 用设备机位出图 / 出片 */
  'device.shoot': async ({ id, kind, type, seconds, aspect, download, hud }) => {
    const e = ed();
    if (!e) return { error: '场景未就绪' };
    const list = (e.devices || []);
    if (!list.length) return { error: '还没有设备机位：先 device.add {kind:"phone"|"drone"}' };
    let d = id ? e.deviceById(id) : list.find(x => x.device === (kind === 'drone' ? 'drone' : kind === 'phone' ? 'phone' : x.device)) || list[0];
    if (!d) return { error: '找不到该机位' };
    const opt = { aspect, seconds, download: download === true, hud };
    if (type === 'image') return await window.__studioDevice.shootImage(d.id, opt);
    const res = await window.__studioDevice.shootVideo(d.id, opt);
    return res;
  },


  'out.open': async ({ file }) => {
    if (!window.WBSave || !window.WBSave.openFolder) return { error: '保存模块未就绪' };
    return await window.WBSave.openFolder(file);
  },

  'out.dir': async () => {
    try {
      const r = await fetch(bridgeUrl() + '/out');
      return await r.json();
    } catch (e) { return { error: '本地桥未启动' }; }
  },

  'help': () => ({ commands: Object.keys(COMMANDS) }),
};

/* ------------------------------------------------------------ */
/* 指令总线                                                      */
/* ------------------------------------------------------------ */
async function run(name, args) {
  const fn = COMMANDS[name];
  if (!fn) return { ok: false, error: '未知指令：' + name, available: Object.keys(COMMANDS) };
  try {
    const data = await fn(args || {});
    if (data && data.error) return { ok: false, error: data.error, data };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

const SYN = [
  ['汽车', '轿车'], ['轿车', '轿车'], ['货车', '货车'], ['卡车', '货车'], ['自行车', '自行车'], ['单车', '自行车'],
  ['人物', '站立的人'], ['一个人', '站立的人'], ['人', '站立的人'],
  ['墙', '墙体'], ['房子', '房子'], ['房间', '房间'], ['楼', '楼房'], ['帐篷', '帐篷'], ['亭子', '亭子'], ['树', '树'],
];

/* v1.2 语义兜底：认不出具体资产名时，按类别给一个最像的（"加一个美女" → 人物） */
const CAT_WORDS = [
  [/美女|帅哥|女孩|男孩|女人|男人|人物|群众|群演|群|人/, 'people'],
  [/车|汽车|卡车|货车|单车|自行车|摩托/, 'vehicles'],
  [/树|草|山|石|木|自然|植物|荒/, 'nature'],
  [/房|楼|墙|亭|帐|塔|建筑|屋|门/, 'buildings'],
  [/桌|椅|沙发|柜|道具|箱|架|灯|家具/, 'props'],
];

/* 自然语言 → 指令（本地关键词解析，不联网） */
function parse(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      const name = j.cmd || j.command || j.name;
      if (name) return { name, args: j.args || j.params || {} };
    } catch (_) { /* 落到关键词 */ }
  }
  const has = (...ws) => ws.some(w => t.includes(w));
  const num = (re) => { const m = t.match(re); return m ? Number(m[1]) : undefined; };
  const PRESETS = ['正午', '黄昏', '夜景', '影棚', '侧光'];

  if (has('打开文件夹', '输出文件夹', '打开目录', 'output folder')) return { name: 'out.open', args: {} };
  if (has('帮助', 'help', '能做什么', '指令')) return { name: 'help', args: {} };
  if (has('状态', 'state', '现在')) return { name: 'state.get', args: {} };
  if (has('播放', 'play')) return { name: 'shot.play', args: {} };
  if (has('停止', 'stop', '暂停')) return { name: 'shot.stop', args: {} };
  if (has('渲染', '出图', 'render')) return { name: 'render', args: { w: num(/(\d{3,4})\s*[x×]\s*(\d{3,4})/) || 1920, h: 1080 } };
  if (has('分镜表', 'storyboard')) return { name: 'storyboard.open', args: {} };
  if (has('导出视频', '录视频', '出视频', '视频导出', 'video')) {
    const m = t.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/);
    return { name: 'video.export', args: { w: m ? Number(m[1]) : 1280, h: m ? Number(m[2]) : 720, fps: 30, mode: has('成片') ? 'film' : 'wb', download: true } };
  }
  if (has('保存', 'save')) return { name: 'scene.save', args: {} };
  if (has('删除', 'delete', '删掉')) return { name: 'asset.delete', args: {} };
  if (has('阵列', '复制', '一排', '群众')) return { name: 'asset.array', args: { cols: 4, rows: 3, gap: 1.4 } };
  if (has('落地', '贴地', '放地上', '放到地上', '接触地面', '落到地面', 'drop')) return { name: 'asset.drop', args: {} };
  if (has('去重叠', '别重叠', '不要重叠', '不要穿插', '分开', '摆开', '分开点', '错开', '解重叠')) {
    const c = num(/间隙\s*(\d+(?:\.\d+)?)/);
    return { name: 'scene.layout.solve', args: c ? { clearance: c } : {} };
  }
  if (has('有哪些', '清单', '资产列表', 'list')) return { name: 'asset.list', args: {} };

  // 灯光：预设词优先（"换成正午光"/"正午"/"换成黄昏"都算），其次亮度/色温
  const presetHit = PRESETS.find(x => t.includes(x));
  if (presetHit && has('光', '灯', '亮', '环境光', '换成', '切成', '调成', '切换')) {
    return { name: 'light.preset', args: { name: presetHit } };
  }
  if (presetHit && /(光|灯)/.test(t)) return { name: 'light.preset', args: { name: presetHit } };
  if (has('灯', 'light')) {
    const k = num(/色温\s*(\d{3,5})/);
    if (k) return { name: 'light.set', args: { kelvin: k } };
    const b = num(/亮度\s*(\d+(?:\.\d+)?)/);
    if (b) return { name: 'light.set', args: { intensity: b > 3 ? b / 100 : b } };
    return { name: 'light.set', args: {} };
  }

  if (has('环境', 'env', '房间', '街道', '神庙', '办公室', '荒野', '影棚', '空房')) {
    const map = { 空房: 'room', 房间: 'room', 街道: 'street', 神庙: 'temple', 办公室: 'office', 荒野: 'wild', 影棚: 'studio' };
    const key = Object.keys(map).find(k => t.includes(k));
    if (key) return { name: 'env.load', args: { env: map[key] } };
    return { name: 'env.load', args: { env: 'room' } };
  }
  if (has('手机机位', '无人机机位', '设备机位', '加个机位', '加机位')) {
    const k = has('无人机') ? 'drone' : 'phone';
    return { name: 'device.add', args: { kind: k } };
  }
  if (has('拍照', '拍一张', '拍张', '截一张')) {
    return { name: 'device.shoot', args: { type: 'image', download: true } };
  }
  if (has('录视频', '录一段', '拍一段', '设备录像')) {
    const s = num(/(d+(?:.d+)?)s*(?:秒|s)/);
    return { name: 'device.shoot', args: { type: 'video', seconds: s || 3, download: true } };
  }
  if (has('镜头', 'shot', '机位')) {
    const d = num(/(\d+(?:\.\d+)?)\s*(?:秒|s)/);
    if (has('预演', '预览')) {
      const i = num(/(?:第\s*)?(\d+)\s*(?:个)?镜头/);
      return { name: 'shot.preview', args: typeof i === 'number' ? { index: i - 1 } : { index: 0 } };
    }
    return { name: 'shot.add', args: { label: t.slice(0, 20), duration: d } };
  }
  if (has('加', '添加', '放一个', '放个', '来个', '加个', '摆个', 'add')) {
    let a = findAssetByText(t);
    if (!a) {
      for (const [kw, name] of SYN) {
        if (t.includes(kw)) {
          a = findAssetByText(name);
          if (a) break;
        }
      }
    }
    if (!a) {
      // 语义兜底：认不出名字就看类别（人物/载具/建筑/自然/道具）
      for (const [re, cat] of CAT_WORDS) {
        if (!re.test(t)) continue;
        const list = (window.WB_ASSETS || []).filter(x => x.cat === cat && x.id !== '__empty');
        if (list.length) { a = list[0]; break; }
      }
    }
    if (a) return { name: 'asset.add', args: { asset: a.name } };
    // 实在认不出：把资产清单给用户（也方便 AI 自我纠正）
    return { name: 'asset.list', args: {} };
  }
  return null;
}

/* ------------------------------------------------------------ */
/* 右侧指令面板                                                  */
/* ------------------------------------------------------------ */
let panel = null;
let logEl = null;
let inputEl = null;
let statusEl = null;
let sse = null;

/* ────────────────────────────────────────────────────────────────
 * 对话记录：**按场景分桶**
 *
 * ★ 2026-10-26（用户原话：「后面VideoForge进行白膜视频阶段操作时，
 *   一个会话框里的内容尽量只出现在一个场景里面（不要重复多开），
 *   除非确实是两个或者是多个世界」）：
 *   以前整个面板只有**一个全局日志**，切场景也不换 ⇒ A 场景里聊过的话，
 *   在 B 场景的同一个面板里还挂着，看起来像"一个会话被复制到了所有场景"。
 *   现在：sceneKey → 行 的映射，面板只渲染**当前场景**那一桶。
 *   · 场景键 = 已保存场景的记录 id / 草稿的一次性 key / 空（没有场景）
 *   · 老场景没有桶 = 空桶（**不串内容**）
 *   · 桶落在 localStorage，刷新/重开还在（沉淀）
 * ──────────────────────────────────────────────────────────────── */
const LOG_STORE_KEY = 'wb-agent-log-v1';
const logBuckets = new Map();     // sceneKey → [{kind,title,body}]
let currentSceneKey = '';

function loadLogBuckets() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOG_STORE_KEY) || '{}');
    for (const [k, rows] of Object.entries(raw)) if (Array.isArray(rows)) logBuckets.set(k, rows);
  } catch (_) { /* 忽略：坏数据就当没有 */ }
}
function saveLogBuckets() {
  try {
    const out = {};
    let n = 0;
    for (const [k, rows] of logBuckets) {
      if (!rows.length) continue;
      out[k] = rows.slice(-200);      // 每桶最多留 200 行，别把 localStorage 撑爆
      if (++n >= 60) break;
    }
    localStorage.setItem(LOG_STORE_KEY, JSON.stringify(out));
  } catch (_) { /* 忽略 */ }
}
function logBucket(key) {
  const k = key || '';
  if (!logBuckets.has(k)) logBuckets.set(k, []);
  return logBuckets.get(k);
}
function renderLog() {
  if (!logEl) return;
  logEl.innerHTML = '';
  const rows = logBucket(currentSceneKey);
  if (!rows.length) {
    const hint = document.createElement('div');
    hint.className = 'ag-row ag-hint';
    hint.innerHTML = currentSceneKey
      ? '<div class="ag-row-head">这个场景还没有对话</div>'
      : '<div class="ag-row-head">未打开场景</div><pre>打开一个场景后再下指令；对话会各自留在各自的场景里。</pre>';
    logEl.appendChild(hint);
    return;
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'ag-row ' + r.kind;
    row.innerHTML = `<div class="ag-row-head">${r.title}</div>${r.body ? `<pre>${r.body}</pre>` : ''}`;
    logEl.appendChild(row);
  }
  logEl.scrollTop = logEl.scrollHeight;
}
/** 切到某个场景的对话桶（app.js 在打开/切换场景时调用） */
function switchScene(key) {
  currentSceneKey = key || '';
  renderLog();
}
/** 草稿存成正式场景后，把它的对话桶改名（对话不丢，但从此绑在场景记录上） */
function renameScene(from, to) {
  if (!from || !to || from === to) return;
  const rows = logBuckets.get(from);
  if (rows && rows.length) logBuckets.set(to, rows);
  logBuckets.delete(from);
  saveLogBuckets();
  if (currentSceneKey === from) currentSceneKey = to;
  renderLog();
}

function buildPanel() {
  if (panel) return panel;
  const el = document.createElement('aside');
  el.id = 'agentPanel';
  el.className = 'agent-panel';
  el.hidden = true;
  el.innerHTML = `
    <header class="ag-head">
      <b>AI 指令</b>
      <span class="ag-status" id="agStatus">本地</span>
      <button class="ag-close" type="button" title="收起">×</button>
    </header>
    <div class="ag-log" id="agLog"></div>
    <div class="ag-chips" id="agChips">
      <button type="button" data-chip="加一个站立的人">加人</button>
      <button type="button" data-chip="换成正午光">正午光</button>
      <button type="button" data-chip="把当前相机存成镜头">加镜头</button>
      <button type="button" data-chip="播放">播放</button>
      <button type="button" data-chip="渲染 1920x1080">渲染</button>
      <button type="button" data-chip="帮助">帮助</button>
    </div>
    <div class="ag-input">
      <textarea id="agText" rows="2" placeholder="输入指令，例如：加一辆汽车 / 换黄昏光 / 加 3 秒镜头 / {&quot;cmd&quot;:&quot;light.preset&quot;,&quot;args&quot;:{&quot;name&quot;:&quot;夜景&quot;}}"></textarea>
      <button id="agSend" type="button">发送</button>
    </div>`;
  document.body.appendChild(el);
  panel = el;
  logEl = $('#agLog', el);
  inputEl = $('#agText', el);
  statusEl = $('#agStatus', el);
  renderLog();          // 只渲染当前场景的对话桶（不是全局历史）

  $('.ag-close', el).addEventListener('click', () => hide());
  $('#agSend', el).addEventListener('click', () => sendFromInput());
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendFromInput(); }
  });
  $('#agChips', el).addEventListener('click', (e) => {
    const b = e.target.closest('[data-chip]');
    if (!b) return;
    inputEl.value = b.dataset.chip;
    sendFromInput();
  });
  return el;
}

function addLog(kind, title, body) {
  // 落到**当前场景**的桶里（不是全局日志）—— 一个场景一个会话框
  logBucket(currentSceneKey).push({ kind, title, body: body ? String(body) : '' });
  saveLogBuckets();
  renderLog();
}

async function sendFromInput() {
  const text = (inputEl.value || '').trim();
  if (!text) return;
  inputEl.value = '';
  addLog('user', '你', text);
  const parsed = parse(text);
  if (!parsed) {
    addLog('err', '无法解析', '试试：「加一个站立的人」「加一辆汽车」「换成正午光 / 换成黄昏光」「加 3 秒镜头」「播放」「渲染 1920x1080」，或直接发 JSON 指令。也支持英文 add/light/play/render。');
    return;
  }
  const res = await run(parsed.name, parsed.args);
  addLog(res.ok ? 'ok' : 'err', parsed.name, JSON.stringify(res.ok ? res.data : res.error, null, 1).slice(0, 1200));
  flash(res.ok);
}

function flash(ok) {
  if (!panel) return;
  panel.classList.add(ok ? 'flash-ok' : 'flash-err');
  setTimeout(() => panel.classList.remove('flash-ok', 'flash-err'), 420);
}

function show() {
  buildPanel().hidden = false;
  if (sse && sse.readyState === 1) setStatus('已连 Agent 桥', true);
  else connectBridge();
}
function hide() { if (panel) panel.hidden = true; }
function toggle() { if (!panel || panel.hidden) show(); else hide(); }

/* ------------------------------------------------------------ */
/* 本地 Agent 桥：SSE 收指令 / HTTP 回结果                        */
/* ------------------------------------------------------------ */
function setStatus(text, on) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle('on', !!on);
}

function connectBridge() {
  if (sse || typeof EventSource === 'undefined') return;
  const cname = (() => {
    try { return new URL(location.href).searchParams.get('client') || ''; } catch (_) { return ''; }
  })();
  const url = bridgeUrl() + '/events' + (cname ? '?client=' + encodeURIComponent(cname) : '');
  try {
    sse = new EventSource(url);
  } catch (_) { setStatus('本地', false); return; }
  sse.onopen = () => setStatus('已连 Agent 桥', true);
  sse.onerror = () => { setStatus('本地（桥未启动）', false); };

  // v1.3：每 2s 向桥自报当前视图，桥据此把指令路由到「正在编辑器里」的那个页面
  if (!window.__hiTimer) {
    window.__hiTimer = setInterval(() => {
      if (!sse || sse.readyState !== 1) return;
      try {
        fetch(bridgeUrl() + '/hi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client: window.__wbClient || cname || 'page', view: (window.__wb && window.__wb.view) || 'entry', visible: document.visibilityState === 'visible', focus: document.hasFocus() }),
        }).catch(() => {});
      } catch (_) { /* 忽略 */ }
    }, 2000);
  }
  sse.onmessage = async (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg && msg.type === 'hello') {
      window.__wbClient = msg.client || '';
      setStatus('已连 Agent 桥' + (msg.client && msg.client.startsWith('page-') ? '' : '：' + msg.client), true);
      return;
    }
    if (!msg || !msg.id || !msg.name) return;
    const res = await run(msg.name, msg.args || {});
    addLog(res.ok ? 'ok' : 'err', 'agent: ' + msg.name, JSON.stringify(res.ok ? res.data : res.error, null, 1).slice(0, 800));
    flash(res.ok);
    try {
      await fetch(bridgeUrl() + '/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: msg.id, ok: res.ok, data: res.data, error: res.error }),
      });
    } catch (_) { /* 桥断了无妨 */ }
  };
}

/* ------------------------------------------------------------ */
/* 图片导入 = 全景背景（替代"不是 HTML 文件"的报错）              */
/* ------------------------------------------------------------ */
function applyImageAsPanorama(file) {
  if (!file || !/^image\//.test(file.type || '')) return false;
  const url = URL.createObjectURL(file);
  buildPanel();
  addLog('user', '导入图片', file.name);
  run('panorama.set', { url }).then((res) => {
    addLog(res.ok ? 'ok' : 'err', 'panorama.set', res.ok ? '已作为全景背景（' + file.name + '）' : res.error);
    flash(res.ok);
    if (!res.ok) URL.revokeObjectURL(url);
  });
  return true;
}

function setupPanoDrop() {
  // 文件选择框：拦在 app.js 的导入器前面
  document.addEventListener('change', (e) => {
    const inp = e.target;
    if (!inp || inp.id !== 'fileInput') return;
    const f = inp.files && inp.files[0];
    if (f && /^image\//.test(f.type || '')) {
      e.stopImmediatePropagation();
      applyImageAsPanorama(f);
      inp.value = '';
    }
  }, true);

  // 拖拽：图片 → 全景背景；HTML/JSON 交回 app.js 的导入器
  document.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const f = files[0];
    if (/^image\//.test(f.type || '')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      applyImageAsPanorama(f);
    }
  }, true);
}

/* ------------------------------------------------------------ */
/* 启动                                                          */
/* ------------------------------------------------------------ */
function init() {
  loadLogBuckets();
  window.WB_AGENT = {
    run,
    parse,
    commands: () => Object.keys(COMMANDS),
    register: (name, fn) => { if (typeof name !== 'string' || typeof fn !== 'function' || COMMANDS[name]) throw new Error('指令已存在或格式无效'); COMMANDS[name] = fn; },
    show, hide, toggle,
    log: addLog,
    // 一个场景一个会话框：app.js 在打开/切换场景时调用这两个
    switchScene, renameScene,
    sceneKey: () => currentSceneKey,
  };
  setupPanoDrop();
  // 顶栏加一个「AI 指令」入口
  const mo = new MutationObserver(() => {
    const tools = document.querySelector('.tb-tools');
    if (!tools || tools.querySelector('#tbAgent')) return;
    const b = document.createElement('button');
    b.className = 'tb-btn';
    b.id = 'tbAgent';
    b.type = 'button';
    b.title = '打开 AI 指令窗（人发指令 / Agent 经 MCP 发指令，同一套命令）';
    b.textContent = 'AI 指令';
    b.addEventListener('click', toggle);
    tools.appendChild(b);
  });
  mo.observe(document.body, { childList: true, subtree: true });
  connectBridge();
  window.addEventListener('beforeunload', () => { try { sse && sse.close(); } catch (_) {} });
  window.addEventListener('pagehide', () => { try { sse && sse.close(); } catch (_) {} });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
