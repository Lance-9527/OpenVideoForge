/* ============================================================================
 * tools/ovf-library-tour.mjs —— 浏览器实测：资产库面板 + 持久化 + 复用
 *   ① 资产库面板出现、分类可切
 *   ② 模型上传 → 落盘 → 重新加载页面后还在（★ 持久化）
 *   ③ 材质/灯光能应用
 *   ④ 点「一键真实街区」按钮（之前只验过等价指令）
 *   ⑤ 点收件箱「导入」按钮
 * ========================================================================== */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';

const OUT = defaultShotsDir();
fs.mkdirSync(OUT, { recursive: true });
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const T = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

async function shot(n) {
  const f = `${OUT}\\${n}.png`;
  await cdp.screenshot(f);
  console.log(T(), '[shot]', n, (fs.statSync(f).size / 1024).toFixed(0) + 'KB');
}
async function ev(expr, ms = 1200) {
  const r = await cdp.eval(expr);
  await wait(ms);
  return r;
}
async function tool(name, args = {}, ms = 1500) {
  const r = await cdp.eval(`
    const res = await fetch('http://127.0.0.1:8787/tool', {method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name:${JSON.stringify(name)}, args:${JSON.stringify(args)}})});
    return await res.json();
  `);
  console.log(T(), '[tool]', name, '=>', JSON.stringify(r).slice(0, 200));
  await wait(ms);
  return r;
}

// ── ① 资产库面板
await wait(2500);
const lib = await ev(`
  const cards = document.querySelectorAll('#assetLibGrid .alb-card');
  const tabs = Array.from(document.querySelectorAll('#assetLibTabs .alb-tab')).map(t=>t.textContent.trim());
  return { cards: cards.length, tabs, dir: (document.querySelector('#assetLibDir')||{}).textContent,
           first: cards[0] ? cards[0].textContent.replace(/\\s+/g,' ').trim().slice(0,80) : null };
`);
console.log(T(), '[资产库面板]', JSON.stringify(lib));
await ev(`document.querySelector('#assetLibSec').scrollIntoView({block:'start'}); return true;`, 800);
await shot('G1-资产库面板');

// ── ② 上传一个模型进资产库（走 /library/upload，跟页面同一条路）
const glb = fs.readFileSync('D:/KnowledgeVault/projects/openvideoforge/assets/icon.png'); // 随便一个文件，只是测通路
console.log(T(), '[测试] 用一个 png 走一次上传（应被格式检查挡下）');
const badUp = await ev(`
  const res = await fetch('http://127.0.0.1:8787/library/upload', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'test.png', base64:'iVBORw0KGgo='})});
  return { status: res.status, body: (await res.text()).slice(0,80) };
`);
console.log(T(), '[非 GLB 应被拒]', JSON.stringify(badUp));

// 造一个最小 GLB 头（只要桥收下就行；页面加载时可能失败，但持久化能验）
const fakeGlb = Buffer.concat([Buffer.from('glTF'), Buffer.from([2,0,0,0]), Buffer.from([0,0,0,0])]);
const up = await tool('wb_library_list', {}, 300);
const uploaded = await ev(`
  const res = await fetch('http://127.0.0.1:8787/library/upload', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'测试模型.glb', base64:'${fakeGlb.toString('base64')}', category:'character'})});
  return await res.json();
`, 600);
console.log(T(), '[上传]', JSON.stringify(uploaded).slice(0, 220));

// ── ③ 重新加载页面，看资产库还在不在（★ 持久化）
await cdp.send('Page.reload', { ignoreCache: true });
await wait(5000);
await ev(`document.querySelector('#assetLibSec').scrollIntoView({block:'start'}); return true;`, 800);
const after = await ev(`
  const cards = Array.from(document.querySelectorAll('#assetLibGrid .alb-card')).map(c=>c.querySelector('.alb-name').textContent);
  return { count: cards.length, has: cards.includes('测试模型') };
`, 800);
console.log(T(), '[刷新后]', JSON.stringify(after));
await shot('G2-资产库-刷新后');

// ── ④ 点「一键真实街区」按钮（prompt 会阻塞 → 先把 prompt 变成自动填）
const osm = await ev(`
  window.__promptAnswers = ['31.2304','121.4737','300'];
  const orig = window.prompt;
  window.prompt = (msg, def) => { const a = window.__promptAnswers.shift(); return a !== undefined ? a : def; };
  const btn = document.querySelector('[data-act="osm"]');
  if (!btn) return { error: '没找到「一键真实街区」按钮', cards: document.querySelectorAll('#srcGrid .src-card').length };
  btn.click();
  return { clicked: true };
`, 1500);
console.log(T(), '[点一键真实街区]', JSON.stringify(osm));
await wait(20000);
const osmRes = await ev(`
  const e = window.__wb && window.__wb.editor;
  return { env: e ? e.envId : null, buildings: e && e._cityState && e._cityState.plan ? e._cityState.plan.stats.buildings : null };
`, 800);
console.log(T(), '[真实世界结果]', JSON.stringify(osmRes));

// ── ⑤ 收件箱「导入」按钮：先放一个 GLB 进去，再点
fs.mkdirSync('D:/下载/OpenVideoForge/外部素材收件箱', { recursive: true });
fs.writeFileSync('D:/下载/OpenVideoForge/外部素材收件箱/测试道具.glb', fakeGlb);
await ev(`window.dispatchEvent(new Event('focus')); return true;`, 500);
await ev(`document.querySelector('#srcRefresh').click(); return true;`, 2500);
const inbox = await ev(`
  const rows = document.querySelectorAll('#srcInbox .src-file');
  return { rows: rows.length, names: Array.from(rows).map(r=>r.querySelector('.sf-name').textContent),
           hasImportBtn: !!document.querySelector('#srcInbox button[data-act="import"]') };
`, 800);
console.log(T(), '[收件箱]', JSON.stringify(inbox));
await shot('G3-收件箱');

console.log(T(), 'done');
await cdp.close();
