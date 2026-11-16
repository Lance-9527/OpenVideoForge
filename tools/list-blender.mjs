#!/usr/bin/env node
/* 列出可用的 Blender Windows 便携 zip（试多个源） */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const sources = [
  ['官方', (br) => `https://download.blender.org/release/${br}/`],
  ['阿里云', (br) => `https://mirrors.aliyun.com/blender/release/${br}/`],
  ['清华', (br) => `https://mirrors.tuna.tsinghua.edu.cn/blender/release/${br}/`],
];
const branches = ['Blender4.2', 'Blender4.5'];
for (const [name, mk] of sources) {
  for (const br of branches) {
    const url = mk(br);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) { console.log(`${name} ${br} → HTTP ${r.status}`); continue; }
      const t = await r.text();
      const m = [...t.matchAll(/href="([^"]*windows-x64\.zip)"/g)].map((x) => x[1]);
      console.log(`✓ ${name} ${br} → ${m.length} 个文件`);
      for (const f of m.slice(-4)) console.log('    ' + f);
    } catch (e) {
      console.log(`${name} ${br} → 失败 ${e.message}`);
    }
  }
}
