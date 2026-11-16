#!/usr/bin/env node
/* 把页面停在入口页 + 截图（不关浏览器） */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
const SHOTS = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 切到入口页
await cdp.eval(`if (window.__wb && window.__wb.switchView) window.__wb.switchView('entry'); return 1;`);
await wait(1200);
const r = await cdp.eval(`
  const card = document.querySelector('#enCardLast');
  const t = document.querySelector('#enCardLastTitle');
  const s = document.querySelector('#enCardLastSub');
  return { view: window.__wb.view, cardHidden: card?card.hidden:null,
           title: t?t.textContent:null, sub: s?s.textContent:null };
`);
console.log(JSON.stringify(r, null, 1));

// 整页截图
const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
if (shot && shot.data) {
  const f = path.join(SHOTS, 'entry-with-last.jpg');
  fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
  console.log('已存: ovf_shots\\entry-with-last.jpg');
}
await cdp.close();
