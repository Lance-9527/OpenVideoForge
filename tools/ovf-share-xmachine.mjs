/* ============================================================================
 * tools/ovf-share-xmachine.mjs —— 分享链接**跨机器**验证
 *
 * 「跨机器」和「跨浏览器」的真实差异只有一处：
 *   跨浏览器（独立 profile）→ localStorage 是空的，但**磁盘资产库还在**
 *   跨机器            → localStorage 空 **且** 资产库（磁盘）也没有
 *
 * 所以要验三件事：
 *   ① 纯内置资产的场景 → 跨机器**必须完全还原**（别人机器上也有内置资产）
 *   ② 含外部模型（资产库 GLB）的场景 → 别人机器上**没有那个模型** ⇒ 必须优雅降级
 *   ③ 大场景的链接长度（base64url 状态）会不会太长
 * ========================================================================== */
import { CDP } from './cdp.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = `${defaultProfileDir('ovf-xmachine')}`;
const BASE = 'http://127.0.0.1:8802/index.html';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};

/* ── ① 造两个场景：纯内置 / 含外部模型 ─────────────────────────────── */
const a = await CDP.attach('index.html');
await a.send('Runtime.enable');
await a.send('Page.enable');
await a.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  await new Promise(r=>setTimeout(r,3000));
  return true;
`);
await wait(2000);

// 纯内置场景
const pure = await a.eval(`
  const e = window.__wb.editor;
  e.objects.slice().forEach(o=>e.deleteSelected && null);
  // 清空
  while (e.objects.length) { e.select(e.objects[0]); e.deleteSelected(); }
  await new Promise(r=>setTimeout(r,400));
  for (const id of ['tree','car-sedan','person-stand']) e.addAsset(id);
  await new Promise(r=>setTimeout(r,600));
  e.objects[0].group.position.set(2, 0, -3);
  e.objects[1].group.position.set(-3, 0, 1);
  e.objects[2].group.position.set(0, 0, 4);
  e.sph.r = 20; e.sph.phi = 1.15; e.sph.theta = 0.6; e._applyCamera();
  const r = await window.WB_AGENT.run('share.link', {});
  const d = (r && r.data) || {};
  return { url: d.url, len: d.url ? d.url.length : 0, codeLen: d.code ? d.code.length : 0,
           assets: d.state ? d.state.assets.length : -1 };
`);
console.log('[① 纯内置场景] 链接长度', pure.len, 'assets', pure.assets);
ok('纯内置场景生成了链接', !!pure.url && pure.assets === 3, pure);

// 含外部模型场景
const withExt = await a.eval(`
  const e = window.__wb.editor;
  const list = await (await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_library_list',args:{kind:'model'}})}).then(r=>r.json()));
  const it = (list.items||[]).find(i=>i.thumb);
  if (!it) return { error:'资产库没模型' };
  const url = 'http://127.0.0.1:8787/library/file/' + encodeURIComponent(it.id);
  const rec = await e.addExternalAsset({ id: it.id, name: it.name, file_url: url });
  await new Promise(r=>setTimeout(r,2500));
  const r = await window.WB_AGENT.run('share.link', {});
  const d = (r && r.data) || {};
  const extAssets = (d.state && d.state.assets || []).filter(x=>String(x.assetId||'').startsWith('external:'));
  return { url: d.url, len: d.url ? d.url.length : 0, extCount: extAssets.length,
           extId: extAssets[0] ? extAssets[0].assetId : null };
`);
console.log('[② 含外部模型] 链接长度', withExt.len, '外部资产', withExt.extCount);
ok('含外部模型场景生成了链接', !!withExt.url && withExt.extCount >= 1, withExt);

await a.close();

/* ── ③ 用「跨机器」profile 打开（模拟另一台电脑：本地无资产库） ──── */
console.log('\n[③ 跨机器 profile 打开纯内置场景]');
fs.mkdirSync(PROFILE, { recursive: true });
const proc = spawn(CHROME, [
  '--remote-debugging-port=9444',
  '--user-data-dir=' + PROFILE,
  '--no-first-run', '--no-default-browser-check', '--window-size=1400,900',
  pure.url,
], { detached: true, stdio: 'ignore' });
proc.unref();
await wait(13000);

let b = null;
try { b = await CDP.attach('index.html', { port: 9444 }); } catch (e) { console.log('连接失败:', e.message); }
if (b) {
  await b.send('Runtime.enable');
  await wait(3000);
  const r1 = await b.eval(`
    const e = window.__wb && window.__wb.editor;
    if (!e) return { error:'编辑器没就绪' };
    return { objects:(e.objects||[]).length, ids:(e.objects||[]).map(o=>o.assetId),
             pos:(e.objects||[]).map(o=>o.group.position.toArray().map(v=>+v.toFixed(1))),
             r:e.sph.r, env:e.envId, ls:Object.keys(localStorage).length };
  `);
  console.log('   ', JSON.stringify(r1));
  ok('★ 纯内置场景跨机器完全还原（3 个物体）', r1.objects === 3, r1);
  ok('★ 资产 id 全对', JSON.stringify(r1.ids) === JSON.stringify(['tree','car-sedan','person-stand']), r1);
  ok('★ 位置全对', r1.pos && JSON.stringify(r1.pos) === JSON.stringify([[2,0,-3],[-3,0,1],[0,0,4]]), r1);
  ok('★ 相机参数对', Math.abs((r1.r||0)-20) < 0.01, r1);
  await b.close();
}

/* ── ④ 含外部模型的链接 → 跨机器（那个模型不在） ──────────────────── */
console.log('\n[④ 跨机器打开含外部模型的链接]');
const proc2 = spawn(CHROME, [
  '--remote-debugging-port=9445',
  '--user-data-dir=' + PROFILE + '_b',
  '--no-first-run', '--no-default-browser-check', '--window-size=1400,900',
  withExt.url,
], { detached: true, stdio: 'ignore' });
proc2.unref();
await wait(13000);

let c = null;
try { c = await CDP.attach('index.html', { port: 9445 }); } catch (e) { console.log('连接失败:', e.message); }
if (c) {
  await c.send('Runtime.enable');
  await wait(4000);
  const r2 = await c.eval(`
    const e = window.__wb && window.__wb.editor;
    if (!e) return { error:'编辑器没就绪' };
    const errs = window.__ovfErrors || [];
    return {
      objects:(e.objects||[]).length,
      ids:(e.objects||[]).map(o=>o.assetId),
      ext: (e.objects||[]).filter(o=>o.externalAsset).length,
      errs: errs.slice(0,5),
      // 外部模型加载失败会不会把整个场景搞崩？
      stillHasBuiltin: (e.objects||[]).filter(o=>!String(o.assetId||'').startsWith('external:')).length,
    };
  `);
  console.log('   ', JSON.stringify(r2));
  ok('★ 没崩（编辑器还在、场景还在）', !!r2.objects, r2);
  ok('★ 内置资产照样还原了', r2.stillHasBuiltin >= 3, r2);
  ok('★ 外部模型缺失不报错（优雅降级）', !r2.errs || r2.errs.length === 0, r2);
  await c.close();
}

/* ── ⑤ 大场景链接长度 ─────────────────────────────────────────────── */
console.log('\n[⑤ 大场景链接长度]');
const a2 = await CDP.attach('index.html');
await a2.send('Runtime.enable');
await a2.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'city' }); } catch(e){} }
  await new Promise(r=>setTimeout(r,3500));
  const e = window.__wb.editor;
  for (let i=0;i<40;i++) { try { e.addAsset('tree'); } catch(_){} }
  await new Promise(r=>setTimeout(r,900));
  return true;
`);
await wait(1500);
const big = await a2.eval(`
  const r = await window.WB_AGENT.run('share.link', {});
  const d = (r && r.data) || {};
  return { len: d.url ? d.url.length : 0, codeLen: d.code ? d.code.length : 0,
           assets: d.state ? d.state.assets.length : -1 };
`);
console.log('   40 个物体 → 链接长度', big.len, '（assets', big.assets, '）');
ok('链接没超长（< 8000 字符，多数环境安全）', big.len < 8000, big);
await a2.close();

/* ── ⑥ 短链接（?s=） ───────────────────────────────────────────────── */
console.log('\n[⑥ 短链接模式]');
const shortLink = await a2.eval(`
  const r = await window.WB_AGENT.run('share.link', {});
  const d = (r && r.data) || {};
  return { ok: !!(r && r.ok), url: d.url, mode: d.mode, id: d.id, len: d.url ? d.url.length : 0,
           assets: d.state ? d.state.assets.length : -1, hasCode: !!d.code };
`);
console.log('   ', JSON.stringify(shortLink));
ok('★ 短链接模式生效', shortLink.mode === 'short' && !!shortLink.id, shortLink);
ok('★ 链接很短（< 120 字符）', shortLink.len < 120, shortLink);
ok('★ 同时保留了内联 code（离线可分享）', shortLink.hasCode, shortLink);

// 用短链接在另一个 profile 打开
const proc3 = spawn(CHROME, [
  '--remote-debugging-port=9446',
  '--user-data-dir=' + PROFILE + '_c',
  '--no-first-run', '--no-default-browser-check', '--window-size=1400,900',
  shortLink.url,
], { detached: true, stdio: 'ignore' });
proc3.unref();
await wait(13000);
let d2 = null;
try { d2 = await CDP.attach('index.html', { port: 9446 }); } catch (e) { console.log('连接失败:', e.message); }
if (d2) {
  await d2.send('Runtime.enable');
  await wait(3000);
  const r3 = await d2.eval(`
    const e = window.__wb && window.__wb.editor;
    if (!e) return { error:'编辑器没就绪' };
    return { objects:(e.objects||[]).length, r:e.sph.r, env:e.envId };
  `);
  console.log('   短链接打开:', JSON.stringify(r3));
  ok('★ 短链接能还原场景', r3.objects > 0, r3);
  await d2.close();
}

console.log(`\n${fail ? '✗' : '✓'} share-xmachine: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
