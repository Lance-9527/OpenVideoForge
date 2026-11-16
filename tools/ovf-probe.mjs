/* 一次性探针：只看页面状态，不做别的 */
import { CDP } from './cdp.mjs';

const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');

const s = await cdp.eval(`
  const errs = [];
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    envs: (window.WB_ENVIRONMENTS||[]).map(e=>e.id),
    envCount: (window.WB_ENVIRONMENTS||[]).length,
    sizes: Object.keys(window.WB_SCENE_SIZES||{}),
    assets: (window.WB_ASSETS||[]).length,
    canvas: document.querySelectorAll('canvas').length,
    hasAgent: !!window.__studioAgent,
    agentKeys: Object.keys(window).filter(k=>k.startsWith('__')).slice(0,30),
    selects: Array.from(document.querySelectorAll('select')).map(s=>({
      id: s.id, opts: Array.from(s.options).map(o=>o.value)
    })),
    bodyLen: (document.body.innerText||'').length,
  };
`);
console.log(JSON.stringify(s, null, 2));
await cdp.close();
