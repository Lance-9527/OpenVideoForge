/* 直接打桥的工具，看真实返回形状（绕开 PowerShell 编码问题） */
const names = process.argv.slice(2);
for (const n of names) {
  const r = await fetch('http://127.0.0.1:8787/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: n, args: {} }),
  });
  const j = await r.json();
  console.log('=== ' + n + ' ===');
  console.log(JSON.stringify(j, null, 1).slice(0, 1400));
}
