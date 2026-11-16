/* ============================================================================
 * tools/ovf-tour.mjs —— 巡演 v2：真正切到编辑器视图再截图
 *
 * v1 的教训：btnLoadExample 加载了示例但**没切视图**，弹窗还挡着，
 * 7 张截图字节完全相同。v2 明确做三件事：
 *   ① 关掉弹窗
 *   ② window.__wb.switchView('editor') 切到编辑器
 *   ③ 等一帧再截图
 * ========================================================================== */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';

const OUT = defaultShotsDir();
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const T = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

async function shot(name) {
  const f = `${OUT}\\${name}.png`;
  await cdp.screenshot(f);
  const sz = fs.statSync(f).size;
  console.log(T(), '[shot]', name, (sz / 1024).toFixed(0) + 'KB');
  return f;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(name, args = {}, waitMs = 1200) {
  const r = await cdp.eval(`
    if (!window.WB_AGENT || !window.WB_AGENT.run) return { ok:false, error:'WB_AGENT 没就绪' };
    return await window.WB_AGENT.run(${JSON.stringify(name)}, ${JSON.stringify(args)});
  `);
  console.log(T(), '[run]', name, '=>', JSON.stringify(r).slice(0, 260));
  await wait(waitMs);
  return r;
}

/** 强制切到编辑器视图 + 关弹窗 */
async function gotoEditor() {
  const r = await cdp.eval(`
    const m = document.querySelector('#modal'); if (m) m.hidden = true;
    const lib = document.querySelector('#view-library'); if (lib) lib.hidden = true;
    const en = document.querySelector('#view-entry'); if (en) en.hidden = true;
    const ed = document.querySelector('#view-editor');
    if (ed) ed.hidden = false;
    if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
    window.dispatchEvent(new Event('resize'));
    return { editorVisible: ed ? !ed.hidden : null, hasWb: !!window.__wb };
  `);
  console.log(T(), '[goto-editor]', JSON.stringify(r));
  await wait(1500);
}

console.log(T(), 'attach ok');
await shot('B0-入口页-顶部');

// 滚到素材源面板
await cdp.eval(`
  const s = document.querySelector('#srcSec');
  if (s) s.scrollIntoView({ block: 'start' });
  return true;
`);
await wait(900);
await shot('B1-素材源面板');

/** 开场景（走 window.__wb.openEditor，入口页「新建白膜场景」按钮走的就是这条） */
async function openScene() {
  const r = await cdp.eval(`
    const m = document.querySelector('#modal'); if (m) m.hidden = true;
    if (window.__wb && window.__wb.openEditor) {
      await window.__wb.openEditor({ env: 'room' });
      return { via: '__wb.openEditor' };
    }
    return { via: 'none' };
  `);
  await wait(2500);
  const r2 = await cdp.eval(`
    const lib = document.querySelector('#view-library'); if (lib) lib.hidden = true;
    const en = document.querySelector('#view-entry'); if (en) en.hidden = true;
    const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
    if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
    window.dispatchEvent(new Event('resize'));
    const edt = window.__wb && window.__wb.editor;
    return { edVisible: ed ? !ed.hidden : null, hasEditor: !!edt, hasScene: !!(edt && edt.scene) };
  `);
  await wait(1500);
  console.log(T(), '[open-scene]', JSON.stringify(r), JSON.stringify(r2));
}

await openScene();
await shot('B2-编辑器-默认场景');

// 城市 medium（看街道密度，最能说明"世界变大"）
await run('world.build', { kind: 'city', size: 'medium', seed: 7 }, 3000);
await run('world.info', {}, 300);
await shot('B3-城市-medium');

// 城市 xxl（18000m）
await run('world.build', { kind: 'city', size: 'xxl', seed: 7 }, 3500);
await shot('B4-城市-xxl');

// 真实世界（涩谷，本地缓存）
await run('world.osm', { url: 'http://127.0.0.1:8787/osm/world/35.65950_139.70050_200.json' }, 4500);
await run('world.info', {}, 300);
await shot('B5-真实世界-涩谷');

// 进屋
await run('building.enter', {}, 2500);
await run('building.info', {}, 300);
await shot('B6-室内');

console.log(T(), 'done');
await cdp.close();
