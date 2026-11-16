/* ============================================================================
 * tools/ovf-drive.mjs —— 打开工作台、跑指令、截图（给人看 + 给我自己验）
 *
 * 用法：
 *   node tools/ovf-drive.mjs shot  <输出png>          截当前页
 *   node tools/ovf-drive.mjs state                    打印页面状态
 *   node tools/ovf-drive.mjs run  <name> <jsonArgs>   跑页面里的 wb_* 指令
 *   node tools/ovf-drive.mjs scene <env> <size>       切环境+档位，然后截图
 *   node tools/ovf-drive.mjs osmr <lat> <lng> <r>     载入真实世界，然后截图
 *   node tools/ovf-drive.mjs enter                    进屋，然后截图
 * ========================================================================== */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';

const OUT = defaultShotsDir();
const cmd = process.argv[2] || 'state';

const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

// 等页面里的 App 就绪
const ready = await cdp.eval(`
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (window.WB_ENVIRONMENTS && window.WB_ENVIRONMENTS.length) {
      return { ok: true, envs: window.WB_ENVIRONMENTS.map(e => e.id), size: window.WB_DEFAULT_SCENE_SIZE };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return { ok: false };
`);
console.log('[ready]', JSON.stringify(ready));

async function shot(name) {
  const f = `${OUT}\\${name}.png`;
  await cdp.screenshot(f);
  console.log('[shot]', f);
  return f;
}

async function run(name, args = {}) {
  const r = await cdp.eval(`
    if (!window.__studioAgent || !window.__studioAgent.run) {
      return { ok:false, error:'页面里没有 __studioAgent.run（studio-agent.js 没加载？）',
               keys: Object.keys(window).filter(k => k.startsWith('__')).slice(0,40) };
    }
    return await window.__studioAgent.run(${JSON.stringify(name)}, ${JSON.stringify(args)});
  `);
  console.log('[run]', name, JSON.stringify(r));
  return r;
}

if (cmd === 'shot') {
  await shot(process.argv[3] || 'shot');
} else if (cmd === 'state') {
  const s = await cdp.eval(`
    const s = {
      title: document.title,
      envs: (window.WB_ENVIRONMENTS||[]).map(e=>e.id),
      assets: (window.WB_ASSETS||[]).length,
      bridge: !!(window.WB_AGENT),
      editor: !!window.__editor,
      agentKeys: Object.keys(window).filter(k=>k.startsWith('__')).slice(0,60),
      canvas: document.querySelectorAll('canvas').length,
      bodyText: (document.body.innerText||'').slice(0, 400),
    };
    return s;
  `);
  console.log(JSON.stringify(s, null, 2));
} else if (cmd === 'run') {
  const args = process.argv[4] ? JSON.parse(process.argv[4]) : {};
  await run(process.argv[3], args);
  await new Promise((r) => setTimeout(r, 1500));
  await shot(process.argv[5] || ('run-' + process.argv[3]));
} else if (cmd === 'scene') {
  const env = process.argv[3] || 'city';
  const size = process.argv[4] || 'large';
  await run('env.load', { env, size });
  await new Promise((r) => setTimeout(r, 2500));
  const info = await run('world.info', {});
  await shot(`scene-${env}-${size}`);
} else if (cmd === 'osmr') {
  const lat = Number(process.argv[3]), lng = Number(process.argv[4]), radius = Number(process.argv[5] || 300);
  await run('world.osm', { url: '/osm/world/35.65950_139.70050_200.json' });
  await new Promise((r) => setTimeout(r, 3000));
  await shot('osm');
} else if (cmd === 'enter') {
  await run('building.enter', {});
  await new Promise((r) => setTimeout(r, 2000));
  await run('building.info', {});
  await shot('interior');
} else {
  console.log('未知命令');
}

await cdp.close();
