#!/usr/bin/env node
/* ============================================================================
 * tools/add-huangpu.mjs —— 把「上海黄浦区」加进本地城市表
 *
 * 起因（2026-11-10）：用户说"来个上海黄埔区的场景"。
 *   · 本地表里只有"上海"（市中心），没有区级条目
 *   · 而且"黄埔"是常见误写（正确是"黄浦"）⇒ 两种写法都要能搜到
 *   · Photon 能查到（31.2336, 121.4799），但走网络慢 ⇒ 落进本地表
 * ========================================================================== */
import fs from 'node:fs';

const P = 'server/cities.json';
const j = JSON.parse(fs.readFileSync(P, 'utf8'));
j.cities = j.cities || [];

const NEW = [
  {
    id: 'huangpu-shanghai',
    name: '黄浦区',
    en: 'Huangpu',
    country: '中国',
    state: '上海市',
    lat: 31.2336,
    lng: 121.4799,
    aliases: ['黄浦', '上海市黄浦区', 'Huangpu District', 'Huangpu, Shanghai',
      '黄埔区', '黄埔', '老西门', '外滩', 'The Bund', 'Bund'],
  },
  {
    id: 'pudong-shanghai',
    name: '浦东新区',
    en: 'Pudong',
    country: '中国',
    state: '上海市',
    lat: 31.2213,
    lng: 121.5445,
    aliases: ['浦东', '浦东新区', 'Pudong New Area', '陆家嘴', 'Lujiazui', '东方明珠'],
  },
  {
    id: 'xuhui-shanghai',
    name: '徐汇区',
    en: 'Xuhui',
    country: '中国',
    state: '上海市',
    lat: 31.1884,
    lng: 121.4365,
    aliases: ['徐汇', '徐汇区', 'Xuhui District', 'Xuhui, Shanghai', '衡山路'],
  },
  {
    id: 'jing-an-shanghai',
    name: '静安区',
    en: 'Jing\'an',
    country: '中国',
    state: '上海市',
    lat: 31.2290,
    lng: 121.4480,
    aliases: ['静安', '静安区', 'Jing\'an District', 'Jingan', '南京西路'],
  },
];

const before = j.cities.length;
const ids = new Set(j.cities.map((c) => c.id));
for (const c of NEW) {
  if (ids.has(c.id)) { console.log('  已存在，跳过:', c.id); continue; }
  j.cities.push(c);
  ids.add(c.id);
}
j.version = (Number(j.version) || 1);
fs.writeFileSync(P, JSON.stringify(j, null, 2) + '\n', 'utf8');
console.log(`城市表: ${before} → ${j.cities.length}`);

// 立刻验证
const { findLocal } = await import('../server/geocode.mjs');
for (const q of ['黄浦区', '黄浦', '黄埔区', '黄埔', '外滩', '浦东', '陆家嘴', '徐汇', '静安']) {
  const hit = findLocal(q);
  console.log(`  ${q.padEnd(6)} → ${hit ? `${hit.name} (${hit.lat}, ${hit.lng})` : '没查到'}`);
}
