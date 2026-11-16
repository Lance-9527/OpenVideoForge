import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const dump = await cdp.eval(`
  const grid = document.querySelector('#assetLibGrid');
  const cards = grid ? grid.querySelectorAll('.alb-card').length : 0;
  const btns = grid ? grid.querySelectorAll('[data-act="toggleparts"]').length : 0;
  const lists = grid ? grid.querySelectorAll('.part-list').length : 0;
  const hiddenLists = grid ? grid.querySelectorAll('.part-list[hidden]').length : 0;
  const rows = grid ? grid.querySelectorAll('.part-row').length : 0;
  const sec = document.querySelector('#assetLibSec');
  return { cards, btns, lists, hiddenLists, rows, secExists: !!sec,
           gridChildren: grid ? grid.children.length : -1 };
`);
console.log('[DOM 状态]', JSON.stringify(dump, null, 1));

// 直接调 initAssetLibrary（会 loadLibrary）再试
const r2 = await cdp.eval(`
  window.__initAssetLibrary();
  await new Promise(r=>setTimeout(r,3000));
  const grid = document.querySelector('#assetLibGrid');
  const btns = grid ? grid.querySelectorAll('[data-act="toggleparts"]').length : 0;
  const btn = grid && grid.querySelector('[data-act="toggleparts"]');
  const before = btn ? btn.dataset.id : null;
  if (btn) btn.click();
  await new Promise(r=>setTimeout(r,600));
  const list = grid.querySelector('.part-list:not([hidden])');
  const hidden = grid.querySelectorAll('.part-list[hidden]').length;
  const rows = grid.querySelectorAll('.part-row').length;
  return { btns, before, listFound: !!list, rows, hidden, visibleLists: grid.querySelectorAll('.part-list:not([hidden])').length };
`);
console.log('[刷新后]', JSON.stringify(r2, null, 1));

await cdp.close();
