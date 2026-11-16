import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const r = await cdp.eval(`
  // 先开一个编辑器（不然 window.__wb.editor 是 null）
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'room' }); } catch(e){} }
  await new Promise(r=>setTimeout(r,2500));
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('entry');
  const en = document.querySelector('#view-entry'); if (en) en.hidden = false;
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = true;
  await new Promise(r=>setTimeout(r,1800));
  const grid = document.querySelector('#assetLibGrid');
  const btn = grid.querySelector('[data-act="toggleparts"]');
  if (!btn) return { error: '没有分件按钮' };
  // 点一下可能展开也可能收起（取决于当前状态）—— 以「可见」为准，必要时再点一次
  const openIfNeeded = async () => {
    for (let i = 0; i < 3; i++) {
      const l = grid.querySelector('.part-list:not([hidden])');
      if (l) return l;
      btn.click();
      await new Promise(r=>setTimeout(r,400));
    }
    return null;
  };
  const list = await openIfNeeded();
  const rows = list ? list.querySelectorAll('.part-row').length : 0;
  const row = list && list.querySelector('.part-row');
  if (!row) return { error: '没有分件行', rows };
  const e = window.__wb.editor;
  const before = (e.objects||[]).length;
  row.click();
  await new Promise(r=>setTimeout(r,3000));
  const placed = (e.objects||[]).slice(before);
  let meshes = 0;
  for (const o of placed) o.group.traverse(n=>{ if(n.isMesh) meshes++; });
  return {
    rows,
    before, after: (e.objects||[]).length,
    placedCount: placed.length,
    meshes,
    assetIds: placed.map(o=>o.assetId),
    partName: row.querySelector('.part-name') ? row.querySelector('.part-name').textContent : null,
  };
`);
console.log('[点分件 → 放进场景]', JSON.stringify(r, null, 1));
const ok = r.placedCount === 1 && r.meshes === 1;
console.log(ok ? '✓ 精准 copy 成功：只放进了 1 个物体、1 个 mesh' : '✗ 不是精准 copy');
await cdp.close();
process.exit(ok ? 0 : 1);
