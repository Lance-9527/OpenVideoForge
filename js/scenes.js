// 白膜环境预设：地面 + 天空 + 灯光 + 默认机位
import * as THREE from 'three';
import { makeCity } from './worldgen/city.js?v=76';
(function () {
  /* ────────────────────────────────────────────────────────────────
   * 场地尺度（地图大小）档位
   *
   * ★ 2026-10-26（用户原话：「openVideoForge 的地图大小可以再拓一下，
   *   可以大一些，装得下一个好莱坞；如果需要小场景，设置就行」）：
   *   以前地图大小是**写死**的（街道 120m / 神庙 140m / 荒野 160m），
   *   想拍大场面只能改代码重发版。现在大小是**设置**：
   *     small  = 今天的默认（factor 1，老场景无 size 字段时也走这里）
   *     medium = 中型棚拍（factor 4，街道地面 480m）
   *     large  = 大场景（factor 20，街道地面 2400m —— 装得下一个好莱坞）
   *   档位名与后端设置 `previz_scene_scale`（small/medium/large）同名对齐，
   *   两边可以各调各的，但语义一致。
   *
   * ★ 2026-11-08（用户原话：「我希望我们 openvideoforge 的世界更大」）：
   *   新增 xl / xxl 两档，并且**修掉了 large 档其实没生效的问题** ——
   *   相机远裁面、阴影相机、太阳距离、网格、放置偏移、景别半径
   *   之前全是按 small 写死的常量，见 editor.js 的 `_applySceneScale()`。
   *   现在还差的：**内容密度**（档位只把世界放大，没有把物件变多），
   *   下一轮给街道/荒野加"按面积铺量"的程序化生成 + LOD。
   * ──────────────────────────────────────────────────────────────── */
  const SCENE_SIZES = {
    small: { id: 'small', label: '小场景', factor: 1, desc: '今天的默认尺寸（室内 6×8m 级）' },
    medium: { id: 'medium', label: '中场景', factor: 4, desc: '约 4 倍（街道地面 480m）' },
    large: { id: 'large', label: '大场景', factor: 20, desc: '约 20 倍（街道地面 2400m，好莱坞级外景）' },
    xl: { id: 'xl', label: '超大型', factor: 30, desc: '约 30 倍（街道地面 3600m，一座城区）' },
    // ★ 2026-11-08 从 150 收到 50：18km×18km = 324 km²，
    //   按真实城市密度该有几十万栋楼，任何预算内都必然显得稀疏。
    //   6km×6km = 36 km²，配 ~1.8 万栋 ≈ 500 栋/km²（与涩谷实测同量级），看起来才像城。
    xxl: { id: 'xxl', label: '巨型', factor: 50, desc: '约 50 倍（街道地面 6000m，航拍级）' },
  };
  const DEFAULT_SIZE = 'small';
  window.WB_SCENE_SIZES = SCENE_SIZES;
  window.WB_DEFAULT_SCENE_SIZE = DEFAULT_SIZE;
  /** 档位 → 缩放系数（脏数据/老场景一律退回 small = 今天的尺寸） */
  function sizeFactor(id) {
    const s = SCENE_SIZES[id];
    return s ? s.factor : (SCENE_SIZES[DEFAULT_SIZE] ? SCENE_SIZES[DEFAULT_SIZE].factor : 1);
  }
  window.WB_SCENE_SIZE_FACTOR = sizeFactor;

  /* ★ 2026-10-26（用户原话：「用户在交互的时候容易点到地板从而难以操作，
   *   要不地板就不允许点击，除了agent自行修改」）：
   *   地板**不允许被鼠标点选**（userData.pickable=false）。
   *   原因：以前点到地板 → 被「接管成普通物体」→ 整块地面变成一个可选中、
   *   可拖动、可删除的大物件，之后视角/选中全乱（用户说"难以操作"）。
   *   注意：地板照样吃阴影、照样能被 **agent** 改 —— agent 是按 instanceId
   *   寻址的（studio-agent.js / studio-bridge.js），根本不靠鼠标拾取，
   *   所以这里禁用的只是"人的鼠标"，不影响 AI 流水线。
   *   墙/桌/道具仍然可点（它们是真的可以编辑的）。 */
  function markFloor(mesh, name) {
    mesh.name = name || 'floor';
    mesh.userData.pickable = false;
    mesh.userData.role = 'floor';
    return mesh;
  }
  window.WB_MARK_FLOOR = markFloor;

  function ground(size, color, receive) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: color, roughness: 0.96 })
    );
    m.rotation.x = -Math.PI / 2;
    m.receiveShadow = true;
    return markFloor(m, 'floor');
  }
  function box(w, h, d, color, x, y, z, ry) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color: color, roughness: 0.92 }));
    m.position.set(x || 0, y || 0, z || 0);
    if (ry) m.rotation.y = ry;
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }
  function cyl(rt, rb, h, color, x, y, z, seg) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 12),
      new THREE.MeshStandardMaterial({ color: color, roughness: 0.92 }));
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  /* 把一整套环境按 factor 放大（小场景 = 1 = 今天的样子）。
   * 为什么整体缩放而不是只放大地面：地面大了但房子还是那么小 ⇒ 画面像
   * "沙滩上的积木"，比例全错。整体等比放大才能保住构图关系。 */
  function finish(objs, k, opts) {
    const f = (typeof k === 'number' && isFinite(k) && k > 0) ? k : 1;
    if (Math.abs(f - 1) > 1e-6) {
      for (const o of objs) {
        o.scale.multiplyScalar(f);
        o.position.multiplyScalar(f);
      }
    }
    return {
      objects: objs,
      sky: opts.sky,
      fog: [opts.fog[0], opts.fog[1] * f, opts.fog[2] * f],
      sun: opts.sun,
      cam: opts.cam.map(v => v * f),
      tgt: opts.tgt.map(v => v * f),
      factor: f,
    };
  }

  function envRoom(k) {
    const objs = [];
    objs.push(markFloor(box(14, 0.2, 14, 0xcfc9bb, 0, -0.1, 0), 'floor-room'));  // 地板
    objs.push(box(14, 3.2, 0.3, 0xe8e4da, 0, 1.6, -7));                       // 后墙
    objs.push(box(0.3, 3.2, 14, 0xe8e4da, -7, 1.6, 0));                       // 左墙
    objs.push(box(0.3, 3.2, 14, 0xe0dcd2, 7, 1.6, 0));                        // 右墙
    objs.push(box(2.2, 2.2, 0.1, 0xd5d0c2, -3.5, 1.5, 6.85));                 // 窗
    objs.push(box(1.1, 2.2, 0.1, 0xcfc9bb, 4.5, 1.1, 6.85));                  // 门
    objs.push(box(3.2, 0.08, 1.2, 0xddd8ca, -4, 0.78, 2));                    // 桌
    for (const [lx, lz] of [[-1.4, 0.45], [-1.4, -0.45], [1.4, 0.45], [1.4, -0.45]])
      objs.push(box(0.09, 0.74, 0.09, 0xd3cec0, -4 + lx, 0.37, 2 + lz));      // 桌腿
    return finish(objs, k, { sky: 0xeceae4, fog: [0xeceae4, 30, 70], sun: 1.15, cam: [4.5, 4.5, 5.5], tgt: [0, 1.2, 0] });
  }
  function envStreet(k) {
    const objs = [];
    objs.push(ground(120, 0xc4c8bc));
    objs.push(markFloor(box(120, 0.06, 9, 0xb9bdc0, 0, 0.03, 0), 'floor-road'));          // 柏油路
    for (let i = -5; i <= 5; i++) objs.push(markFloor(box(2.4, 0.04, 0.22, 0xe8e6df, i * 5, 0.05, 0), 'floor-lane')); // 车道线
    objs.push(markFloor(box(120, 0.24, 5, 0xd3d6cb, 0, 0.12, 8.5), 'floor-sidewalk'));     // 人行道
    objs.push(markFloor(box(120, 0.24, 5, 0xd3d6cb, 0, 0.12, -8.5), 'floor-sidewalk'));
    for (let i = -4; i <= 4; i++) {
      if (i === 0) continue;
      objs.push(box(5, 7 + (i % 3) * 1.5, 6, 0xe2ded4, i * 11, (7 + (i % 3) * 1.5) / 2, 13.5));
      objs.push(box(5, 6 + ((i + 1) % 3) * 1.5, 6, 0xdcd8cc, i * 11, (6 + ((i + 1) % 3) * 1.5) / 2, -13.5));
    }
    for (let i = -3; i <= 3; i++) {                                           // 路灯
      const l = cyl(0.07, 0.09, 3.2, 0xb5b2a6, i * 9 + 4.5, 1.6, 8.5, 8);
      objs.push(l); objs.push(box(0.8, 0.1, 0.1, 0xb5b2a6, i * 9 + 4.5 + 0.35, 3.15, 8.5));
    }
    return finish(objs, k, { sky: 0xdfe3e6, fog: [0xdfe3e6, 40, 110], sun: 1.25, cam: [14, 11, 16], tgt: [0, 1, 0] });
  }
  function envTemple(k) {
    const objs = [];
    objs.push(ground(140, 0xd6cfbc));
    objs.push(box(16, 0.6, 26, 0xe0dccd, 0, 0.3, 0));                        // 主台
    for (let i = -1; i <= 1; i++) objs.push(box(1.0, 4.2, 1.0, 0xefeade, i * 4, 2.7, -8)); // 柱
    objs.push(box(14, 0.5, 1.6, 0xe0dccd, 0, 4.7, -8));                       // 楣
    const gate = box(9, 3.4, 1.2, 0xe6e1d2, 0, 2.4, -10.2); objs.push(gate);
    objs.push(box(7, 0.5, 1.8, 0xd8d2c0, 0, 0.85, 3));                        // 阶
    objs.push(box(3.4, 0.5, 3.4, 0xd8d2c0, -5.5, 0.85, 4));
    objs.push(box(3.4, 0.5, 3.4, 0xd8d2c0, 5.5, 0.85, 4));
    return finish(objs, k, { sky: 0xe6e2d4, fog: [0xe6e2d4, 45, 120], sun: 1.3, cam: [16, 10, 18], tgt: [0, 2, -2] });
  }
  function envOffice(k) {
    const objs = [];
    objs.push(markFloor(box(20, 0.2, 16, 0xd2d4d6, 0, -0.1, 0), 'floor-office'));
    objs.push(box(20, 3, 0.3, 0xe6e6e4, 0, 1.5, -8));
    objs.push(box(0.3, 3, 16, 0xe6e6e4, -10, 1.5, 0));
    for (let i = -2; i <= 2; i++) for (let j = -1; j <= 1; j++) {
      objs.push(box(2.4, 0.08, 1.2, 0xe9e7e0, i * 3.6, 0.76, j * 3.4));      // 办公桌
      objs.push(box(2.3, 0.62, 0.06, 0xe0ddd4, i * 3.6, 0.45, j * 3.4 - 0.5)); // 桌下挡板
      objs.push(box(0.5, 0.5, 0.5, 0xd8d5cc, i * 3.6, 1.05, j * 3.4));       // 显示器
      objs.push(box(0.45, 0.8, 0.45, 0xdedbd2, i * 3.6 + 1.0, 0.4, j * 3.4 + 0.6)); // 椅
    }
    objs.push(box(0.15, 2.4, 6, 0xdde8e4, -9.8, 1.2, -2));                   // 玻璃隔断
    return finish(objs, k, { sky: 0xe9ebec, fog: [0xe9ebec, 30, 75], sun: 1.1, cam: [11, 8.5, 11.5], tgt: [0, 1, -1] });
  }
  function envWild(k) {
    const objs = [];
    objs.push(ground(160, 0xc9cbb2));
    for (let i = 0; i < 14; i++) {
      const a = i * 1.7, r = 12 + (i % 5) * 4;
      objs.push(cyl(0.16, 0.26, 1.6, 0xb0ac96, Math.cos(a) * r, 0.8, Math.sin(a) * r, 7));
      const c = new THREE.Mesh(new THREE.SphereGeometry(1.15, 12, 8),
        new THREE.MeshStandardMaterial({ color: 0xc3c9a8, roughness: 0.95 }));
      c.position.set(Math.cos(a) * r, 2.2, Math.sin(a) * r); c.scale.y = 0.9;
      c.castShadow = true; objs.push(c);
    }
    for (let i = 0; i < 10; i++) {
      const a = i * 2.3 + 1, r = 8 + (i % 4) * 5;
      const rock = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 7),
        new THREE.MeshStandardMaterial({ color: 0xbab8a8, roughness: 0.96 }));
      rock.position.set(Math.cos(a) * r, 0.4, Math.sin(a) * r);
      rock.scale.set(1.2, 0.7, 1); rock.castShadow = true; objs.push(rock);
    }
    return finish(objs, k, { sky: 0xdde4e0, fog: [0xdde4e0, 50, 130], sun: 1.35, cam: [15, 9, 17], tgt: [0, 1, 0] });
  }
  function envStudio(k) {
    const objs = [];
    objs.push(ground(80, 0xe4e2dc));
    const cyc = new THREE.Mesh(new THREE.CylinderGeometry(26, 26, 9, 24, 1, true, -Math.PI / 2.2, Math.PI / 1.1),
      new THREE.MeshStandardMaterial({ color: 0xf0eee8, roughness: 0.98, side: THREE.BackSide }));
    cyc.position.y = 4.5; objs.push(cyc);
    objs.push(box(5, 0.3, 5, 0xd6d3ca, 0, 0.15, 0));                          // 中心台
    return finish(objs, k, { sky: 0xf2f0ea, fog: [0xf2f0ea, 35, 85], sun: 1.0, cam: [9, 6.5, 11], tgt: [0, 1.2, 0] });
  }

  /* ── ★ 2026-11-08 新增：程序化城市（大世界的主力环境） ──────────────────
   * 与上面 6 个预设的根本区别：
   *   预设是"手摆的一套布景"，放大 20 倍只会变成一套**巨人的布景**；
   *   城市是**按面积铺量**生成的：街区尺寸恒守在人的尺度上，
   *   变大的是数量。设计规则见 worldgen/plan.js 顶部注释。
   *
   * 注意：这里**绝对不能**走 finish() —— finish 会把物件的位置和缩放
   * 一起乘 factor，那正是"世界放大 = 东西放大"的老毛病。世界尺寸由
   * plan.size 承担，物件保持真实尺寸。 */
  function envCity(k, opts) {
    opts = opts || {};
    const night = opts.style === 'night';
    const built = makeCity(k, { seed: opts.seed, density: opts.density });
    const size = built.plan.size;
    const c = size * 0.12;
    return {
      objects: [built.group],
      sky: night ? 0x1c2333 : 0xdfe3e6,
      fog: night ? [0x1c2333, size * 0.20, size * 0.90]
                 : [0xdfe3e6, size * 0.30, size * 1.15],
      sun: night ? 0.38 : 1.25,
      cam: [c, size * 0.085, c * 1.15],
      tgt: [0, size * 0.012, 0],
      factor: k,
      cityState: built,          // editor.js 用它做运行时 LOD
      // 夜景：低角度、偏冷、弱半球光（loadEnv 会 merge 进 lightOpts）
      lightPreset: night
        ? { elevation: 26, azimuth: 210, kelvin: 4300, intensity: 0.38, hemi: 0.30, shadowSoft: 0.7 }
        : null,
    };
  }

  /* 海滩：沙岸 + 海面 + 棕榈 + 小屋 */
  function envBeach(k) {
    const objs = [];
    objs.push(ground(160, 0xd9cba8));
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(170, 100),
      new THREE.MeshStandardMaterial({ color: 0x8fb6c8, roughness: 0.3, metalness: 0.08 })
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(0, -0.12, -72);
    objs.push(sea);
    for (let i = 0; i < 7; i++) {
      const a = i * 0.9, r = 22 + (i % 3) * 9;
      const x = Math.cos(a) * r, z = 16 + Math.sin(a) * r * 0.5;
      objs.push(cyl(0.16, 0.26, 4.2, 0xb0a086, x, 2.1, z, 8));
      for (let j = 0; j < 5; j++) {
        const aa = (j * Math.PI * 2) / 5;
        const leaf = cone(0.5, 2.6, 0xc2c98f, x + Math.cos(aa) * 0.9, 4.4, z + Math.sin(aa) * 0.9, 4);
        leaf.rotation.set(1.1, -aa, 0);
        objs.push(leaf);
      }
    }
    objs.push(box(4, 2.4, 3.4, 0xe6dfd0, -18, 1.2, 6));
    objs.push(box(4.6, 0.5, 4.0, 0xd8cfbc, -18, 2.65, 6));
    return finish(objs, k, { sky: 0xe4ecef, fog: [0xe4ecef, 60, 150], sun: 1.35, cam: [26, 14, 34], tgt: [0, 1, 0] });
  }

  /* 小巷：两侧楼夹一条窄巷，适合贴脸跟拍 */
  function envAlley(k) {
    const objs = [];
    objs.push(ground(60, 0xc2c4bc));
    objs.push(markFloor(box(60, 0.05, 7, 0xb4b6ba, 0, 0.025, 0), 'floor-alley'));
    for (let i = -3; i <= 3; i++) {
      objs.push(box(5, 12 + (i % 3) * 3, 6, 0xdfdbd0, i * 7, (12 + (i % 3) * 3) / 2, 9));
      objs.push(box(5, 10 + ((i + 1) % 3) * 3, 6, 0xdad6cb, i * 7, (10 + ((i + 1) % 3) * 3) / 2, -9));
    }
    for (let i = -2; i <= 2; i++) objs.push(cyl(0.07, 0.09, 3.2, 0xb5b2a6, i * 10 + 5, 1.6, 4.2, 8));
    return finish(objs, k, { sky: 0xd8dce0, fog: [0xd8dce0, 30, 80], sun: 0.85, cam: [10, 7, 16], tgt: [0, 1.4, 0] });
  }

  window.WB_ENVIRONMENTS = [
    { id: 'room', name: '空房间', desc: '室内 · 三面墙', build: envRoom },
    { id: 'street', name: '街道', desc: '城市场景', build: envStreet },
    { id: 'temple', name: '神庙', desc: '宏大仪式感', build: envTemple },
    { id: 'office', name: '办公室', desc: '工位阵列', build: envOffice },
    { id: 'wild', name: '荒野', desc: '自然外景', build: envWild },
    { id: 'studio', name: '影棚', desc: '无缝白背景', build: envStudio },
    { id: 'city', name: '城市', desc: '程序化城区 · 按面积铺量', build: envCity },
    { id: 'nightcity', name: '夜景城市', desc: '程序化城区 · 夜间低光', build: (k, o) => envCity(k, Object.assign({}, o || {}, { style: 'night' })) },
    { id: 'beach', name: '海滩', desc: '沙岸 + 海面 + 棕榈', build: envBeach },
    { id: 'alley', name: '小巷', desc: '窄巷两面楼 · 跟拍用', build: envAlley }
  ];
})();
