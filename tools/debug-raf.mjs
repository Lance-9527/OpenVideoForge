#!/usr/bin/env node
/* 量 rAF 实际间隔 + 页面可见性 */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const vis = { state: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };
  const t0 = performance.now();
  const times = [];
  await new Promise((res) => {
    let n = 0;
    const step = () => { times.push(Math.round(performance.now()-t0)); if (++n < 6) requestAnimationFrame(step); else res(); };
    requestAnimationFrame(step);
  });
  return { vis, rafAt: times, gaps: times.map((t,i)=> i? t-times[i-1] : t) };
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
