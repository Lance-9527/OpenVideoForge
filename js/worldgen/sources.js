/* ============================================================================
 * js/worldgen/sources.js —— 外部素材源目录（页面与桥共用）
 *
 * 目的：让 openVideoForge 打开就能**直接选**外面现成做好的模型，而不是只能
 *       用自己程序化生成的。
 *
 * ★ 版权口径（2026-11-08 核对原文，来自 https://oyasumi-gamedev.com/tools/terms/）：
 *   允许：工具的**输出**（图片/3D模型/PSD/SVG）可自由用于作品，**含商用**；
 *        把输出传给一起制作的人（助理/团队）**不算再分发**。
 *   禁止：逆向/解析他们的程序以做出同样功能的软件（含让 AI 读源码）；
 *        程序化批量抓取他们的文件；把输出**原样再分发**（素材集/模板/资产包）。
 *
 *   ⇒ 本模块只做三件事：
 *     ① 给出「去哪、用什么参数打开」；
 *     ② 给出「导出什么、署名怎么写」；
 *     ③ 把人导出的文件接进来（收件箱）。
 *   **不复制他们的数据、不解析他们的代码、不批量抓取。**
 *
 *   唯一"能全自动"的一条是 ロケハン（真实街区）—— 因为 openVideoForge 自己
 *   直接查 OpenStreetMap 原始数据（ODbL，与他们的工具无关），所以那条能一键完成。
 * ========================================================================== */

export const SOURCE_CREDIT = {
  haikeigacha: null,                                    // 不涉及地图数据
  worldgacha: null,
  posegacha: null,
  comicmodeler: null,
  rokehan: '© OpenStreetMap contributors',              // ODbL 要求
  oyasumiTools: '使用ツール: 背景ガチャ / ワールドガチャ (MIYADAIKU)',
};

/** 素材源目录 */
export const SOURCES = [
  {
    id: 'haikeigacha',
    name: '背景ガチャ',
    jp: '部屋・建物まるごと・何階もあるダンジョン',
    what: '120 种以上的 3D 房间/建筑/多层地牢，线画+色调风格',
    tool: 'https://tools.oyasumi-gamedev.com/haikeigacha/',
    info: 'https://oyasumi-gamedev.com/tools/haikeigacha/',
    exports: ['PNG', 'GLB'],
    credit: SOURCE_CREDIT.haikeigacha,
    creditNote: '无需署名（不涉及地图数据）',
    auto: false,
    hint: '导出 GLB 后放进收件箱，就能当场景/资产摆进来',
  },
  {
    id: 'worldgacha',
    name: 'ワールドガチャ',
    jp: '城下町・坂の町・ビル街・滝の上の水の都など',
    what: '9 种架空城镇（住宅街/坡城/高楼街/瀑布水都…）',
    tool: 'https://tools.oyasumi-gamedev.com/worldgacha/',
    info: 'https://oyasumi-gamedev.com/tools/worldgacha/',
    exports: ['PNG', 'GLB'],
    credit: SOURCE_CREDIT.worldgacha,
    creditNote: '无需署名',
    auto: false,
    hint: '户外场景/街区底图，导出 GLB 用',
  },
  {
    id: 'rokehan',
    name: 'どこでもロケハン',
    jp: '世界のどこでも、実在の街を3Dに',
    what: '全世界真实街道 3D（OpenStreetMap + 地形高程），带「白模」表现',
    tool: 'https://tools.oyasumi-gamedev.com/rokehan/',
    info: 'https://oyasumi-gamedev.com/tools/rokehan/',
    exports: ['PNG', 'SVG', 'GLB', 'FBX', 'OBJ'],
    credit: SOURCE_CREDIT.rokehan,
    creditNote: '★ 发布作品必须署名 © OpenStreetMap contributors',
    auto: 'osm',
    hint: '这条能全自动：openVideoForge 自己查 OSM 原始数据，一键出真实街区',
  },
  {
    id: 'posegacha',
    name: 'ポーズガチャ',
    jp: 'キャラクターの23種のポーズ',
    what: '23 种角色动作姿势（VRM 角色）',
    tool: 'https://tools.oyasumi-gamedev.com/posegacha/',
    info: 'https://oyasumi-gamedev.com/tools/posegacha/',
    exports: ['PNG', 'VRMA'],
    credit: SOURCE_CREDIT.posegacha,
    creditNote: '无需署名',
    auto: false,
    hint: 'PNG 姿势参考图，可当贴图/参考用',
  },
  {
    id: 'comicmodeler',
    name: 'コミックモデラー',
    jp: '3Dモデルを自分で編集',
    what: '模型编辑器：顶点/边/面级编辑，能读写房间模型与自有模型',
    tool: 'https://tools.oyasumi-gamedev.com/comicmodeler/',
    info: 'https://oyasumi-gamedev.com/tools/comicmodeler/',
    exports: ['GLB', 'OBJ', 'FBX'],
    credit: SOURCE_CREDIT.comicmodeler,
    creditNote: '无需署名',
    auto: false,
    hint: '改完导出 GLB，放进收件箱',
  },
];

/** 收件箱：人把导出的文件放这儿，openVideoForge 一键收编 */
export const INBOX_NAME = '外部素材收件箱';
export const INBOX_ACCEPT = ['.glb', '.gltf', '.png', '.jpg', '.jpeg', '.json'];

export function findSource(id) {
  return SOURCES.find((s) => s.id === id) || null;
}

/** 目录 + 收件箱状态（给 wb_source_list） */
export function sourceCatalog(inbox) {
  return {
    sources: SOURCES.map((s) => ({
      id: s.id,
      name: s.name,
      jp: s.jp,
      what: s.what,
      tool: s.tool,
      info: s.info,
      exports: s.exports,
      credit: s.credit,
      creditNote: s.creditNote,
      auto: s.auto || null,
      hint: s.hint,
    })),
    inbox: inbox || null,
    notice: '导出物请放进收件箱再导入；这些工具的输出可在作品中使用，但请勿原样再分发。',
  };
}
