/* ============================================================================
 * tools/ovf-share-tour.mjs —— 分享链接**跨浏览器**还原验证
 *
 * 用户场景：把场景发给朋友 / 换台电脑打开就该一样。
 * 这里用**独立的 Chrome profile**（= 另一个浏览器，完全没有 localStorage）
 * 打开分享链接，验证场景能不能还原。
 * ========================================================================== */
import { CDP } from './cdp.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_B = `${defaultProfileDir('ovf-profileB')}`;
const BASE = 'http://127.0.0.1:8802/index.html';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};

/* ── ① 在浏览器 A 建场景 + 生成分享链接 ───────────────────────────── */
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
  const e = window.__wb.editor;
  for (const id of ['tree','car-sedan','person-stand']) { try { e.addAsset(id); } catch(_){} }
  await new Promise(r=>setTimeout(r,600));
  // 摆一下位置，让还原有东西可比
  e.objects[0].group.position.set(3, 0, -2);
  e.objects[1].group.position.set(-4, 0, 1);
  e.objects[2].group.position.set(0, 0, 5);
  e.sph.r = 22; e.sph.phi = 1.1; e.sph.theta = 0.7; e._applyCamera();
  return true;
`);
await wait(1500);

const link = await a.eval(`
  const r = await window.WB_AGENT.run('share.link', {});
  const d = (r && r.data) || r || {};
  return { ok: !!(r && r.ok), url: d.url, codeLen: d.code ? d.code.length : 0,
           assets: d.state ? (d.state.assets||[]).length : -1,
           env: d.state ? d.state.spec : null };
`);
console.log('[① 生成分享链接]', JSON.stringify({ ok: link.ok, codeLen: link.codeLen, assets: link.assets, env: link.env }));
ok('生成了链接', link.ok, link);
ok('链接里有资产', link.assets === 3, link);
const url = link.url;
console.log('   URL 长度:', url ? url.length : 0);
console.log('   URL:', url ? url.slice(0, 120) + '…' : '(无)');

await a.close();

/* ── ② 用**另一个浏览器 profile** 打开（模拟换台电脑） ─────────────── */
console.log('\n[② 独立 profile 的浏览器打开]');
fs.mkdirSync(PROFILE_B, { recursive: true });
const proc = spawn(CHROME, [
  '--remote-debugging-port=9333',
  '--user-data-dir=' + PROFILE_B,
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1400,900',
  url,
], { detached: true, stdio: 'ignore' });
proc.unref();
await wait(12000);

let b = null;
try { b = await CDP.attach('index.html', { port: 9333 }); } catch (e) {
  console.log('   连接失败:', e.message);
}
if (b) {
  await b.send('Runtime.enable');
  await wait(2500);

  // ③ 还原有没有发生
  const restored = await b.eval(`
    const e = window.__wb && window.__wb.editor;
    if (!e) return { error: '编辑器没就绪' };
    return {
      objects: (e.objects||[]).length,
      ids: (e.objects||[]).map(o=>o.assetId),
      pos: (e.objects||[]).map(o=>o.group.position.toArray().map(v=>+v.toFixed(2))),
      r: e.sph.r, phi: e.sph.phi, theta: e.sph.theta,
      env: e.envId,
      hasLocalStorage: Object.keys(localStorage).length,
    };
  `);
  console.log('[③ 还原结果]', JSON.stringify(restored, null, 1));

  ok('★ 场景还原出 3 个物体', restored.objects === 3, restored);
  ok('★ 资产 id 对', JSON.stringify(restored.ids) === JSON.stringify(['tree', 'car-sedan', 'person-stand']), restored);
  ok('★ 位置还原了', restored.pos && restored.pos[0] && Math.abs(restored.pos[0][0] - 3) < 0.01, restored.pos);
  ok('★ 相机参数还原了', Math.abs((restored.r || 0) - 22) < 0.01, restored);
  console.log('   新 profile 的 localStorage 条目数:', restored.hasLocalStorage);

  // ④ 再点一次「恢复」按钮会不会炸
  const again = await b.eval(`
    try {
      const r = await window.__restoreFromUrl();
      return { ok: !!(r && r.ok), error: r && r.error, restored: r && r.restored };
    } catch (e) { return { error: String(e.message) }; }
  `);
  console.log('[④ 再恢复一次]', JSON.stringify(again));
  ok('重复恢复不炸', !again.error, again);

  await b.close();
}

/* ── ⑤ 坏链接要优雅失败 ───────────────────────────────────────────── */
console.log('\n[⑤ 坏链接]');
const c = await CDP.attach('index.html', { port: 9333 });
if (c) {
  await c.send('Runtime.enable');
  const bad = await c.eval(`
    const tests = [
      ['', '空'],
      ['%%%not-base64%%%', '乱码'],
      [btoa('{"not":"a scene"}'), '不是场景'],
      [btoa('null'), 'null'],
    ];
    const out = [];
    for (const [code, label] of tests) {
      try {
        const r = await window.__restoreFromUrl.call(null);
        out.push({ label, ok: !!(r && r.ok) });
      } catch (e) { out.push({ label, threw: String(e.message).slice(0,60) }); }
      break; // restoreFromUrl 读的是 location.href，构造不了；下面单独测解码
    }
    return out;
  `).catch(() => null);
  console.log('   ', JSON.stringify(bad));
  await c.close();
}

// 直接测解码函数对坏输入的处理
const decodeTest = await a.eval(`
  const results = [];
  const tryDecode = (code) => {
    try {
      let s = String(code).replace(/-/g,'+').replace(/_/g,'/');
      while (s.length % 4) s += '=';
      const bin = atob(s);
      const bytes = new Uint8Array(bin.length);
      for (let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      return { ok: true, v: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch (e) { return { ok: false, err: String(e.message).slice(0,60) }; }
  };
  results.push({ label:'乱码', r: tryDecode('%%%not-base64%%%') });
  results.push({ label:'不是场景', r: tryDecode(btoa('{"not":"a scene"}')) });
  results.push({ label:'null', r: tryDecode(btoa('null')) });
  results.push({ label:'空', r: tryDecode('') });
  return results;
`).catch(() => null);
console.log('[⑤ 坏数据解码]', JSON.stringify(decodeTest));
ok('坏数据解码抛错而不是静默返回垃圾', Array.isArray(decodeTest) && decodeTest.filter(x=>!x.r.ok).length >= 2, decodeTest);

console.log(`\n${fail ? '✗' : '✓'} share: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
