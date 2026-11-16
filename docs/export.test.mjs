/* ============================================================
 * 分镜导出 · 纯函数测试（Node 端，无浏览器）
 * ------------------------------------------------------------
 * 运行：
 *   node product/docs/export.test.mjs
 *   （在 product/ 目录下：node docs/export.test.mjs）
 *
 * 为什么用 data: URL 动态 import：
 *   product/ 没有 package.json（type 未声明），Node 会把 js/export.js 当 CJS 解析，
 *   直接 `import '../js/export.js'` 会报 "Unexpected token 'export'"。
 *   这里把源码按 UTF-8 读出来，用 data:text/javascript;base64 以 ESM 方式加载，
 *   既不改动产品目录，也不需要任何构建步骤。
 * ============================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'js', 'export.js');
const code = readFileSync(SRC, 'utf8');
const m = await import('data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64'));

const {
  formatTimecode, safeFileName, computeGrid, buildShotRows, totalDuration,
  padIndex, computeSheetLayout, storyboardFileName, shotListFileName,
  packFileName, buildShotListPayload, buildCSV
} = m;

/* ------------------------------------------------------------ */
/* 极简断言框架                                                  */
/* ------------------------------------------------------------ */
let pass = 0, fail = 0;
const failures = [];

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function eq(label, actual, expected) {
  const a = fmt(actual), e = fmt(expected);
  if (a === e) {
    pass++;
    console.log(`  ✓ ${label} → ${a}`);
  } else {
    fail++;
    failures.push(`${label}\n      期望: ${e}\n      实际: ${a}`);
    console.log(`  ✗ ${label} → ${a}  (期望 ${e})`);
  }
}

function ok(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ' → ' + detail : ''}`); }
  else { fail++; failures.push(label + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${label}${detail ? ' → ' + detail : ''}`); }
}

function throws(label, fn, re) {
  try {
    fn();
    fail++; failures.push(label + ' — 没有抛出异常');
    console.log(`  ✗ ${label} → 没有抛出异常`);
  } catch (e) {
    if (re && !re.test(String(e.message))) {
      fail++; failures.push(label + ' — 异常信息不匹配: ' + e.message);
      console.log(`  ✗ ${label} → 异常信息不匹配: ${e.message}`);
    } else {
      pass++; console.log(`  ✓ ${label} → 抛出「${e.message}」`);
    }
  }
}

function section(name) {
  console.log('\n' + name);
}

/* ------------------------------------------------------------ */
/* 1. 时间码 mm:ss.s                                             */
/* ------------------------------------------------------------ */
section('1. formatTimecode —— 时间码 mm:ss.s');
eq('0 秒', formatTimecode(0), '00:00.0');
eq('0.4 秒', formatTimecode(0.4), '00:00.4');
eq('3 秒', formatTimecode(3), '00:03.0');
eq('9.96 秒（进位到 10.0，不能出现 00:60.0）', formatTimecode(9.96), '00:10.0');
eq('59.97 秒（跨分钟）', formatTimecode(59.97), '01:00.0');
eq('65.43 秒', formatTimecode(65.43), '01:05.4');
eq('125.04 秒', formatTimecode(125.04), '02:05.0');
eq('600 秒', formatTimecode(600), '10:00.0');
eq('负数夹到 0', formatTimecode(-3), '00:00.0');
eq('非数字兜底', formatTimecode(undefined), '00:00.0');

/* ------------------------------------------------------------ */
/* 2. 文件名安全化                                               */
/* ------------------------------------------------------------ */
section('2. safeFileName —— 文件名安全化（保留中文，去掉各系统非法字符）');
eq('路径分隔符 / 冒号 / 问号', safeFileName('屋顶 / 追逐: 第1镜?'), '屋顶-追逐-第1镜');
eq('Windows 非法字符 <>:"\\|?*', safeFileName('a*b|c<d>e"f'), 'a-b-c-d-e-f');
eq('连续横线收成一条', safeFileName('A -- B'), 'A-B');
eq('控制符换行变空格', safeFileName('第1镜\n第二行'), '第1镜 第二行');
eq('空串走回退名', safeFileName(''), '未命名');
eq('纯空白走回退名', safeFileName('   '), '未命名');
eq('Windows 保留名加前缀', safeFileName('CON'), '_CON');
eq('首尾点/空白剔除', safeFileName('  ..hidden..  '), 'hidden');
eq('超长截断（≤60）', safeFileName('镜'.repeat(100)).length, 60);
eq('自定义回退名', safeFileName('', '镜头'), '镜头');

/* ------------------------------------------------------------ */
/* 3. 网格行列（4 列上限，不满不留空列）                          */
/* ------------------------------------------------------------ */
section('3. computeGrid —— 分镜网格行列');
eq('0 个镜头', computeGrid(0), { cols: 1, rows: 0 });
eq('1 个镜头', computeGrid(1), { cols: 1, rows: 1 });
eq('2 个镜头', computeGrid(2), { cols: 2, rows: 1 });
eq('3 个镜头', computeGrid(3), { cols: 3, rows: 1 });
eq('4 个镜头', computeGrid(4), { cols: 4, rows: 1 });
eq('5 个镜头', computeGrid(5), { cols: 4, rows: 2 });
eq('8 个镜头', computeGrid(8), { cols: 4, rows: 2 });
eq('9 个镜头', computeGrid(9), { cols: 4, rows: 3 });
eq('13 个镜头', computeGrid(13), { cols: 4, rows: 4 });
eq('100 个镜头', computeGrid(100), { cols: 4, rows: 25 });

/* ------------------------------------------------------------ */
/* 4. 序号补零                                                   */
/* ------------------------------------------------------------ */
section('4. padIndex —— 序号补零');
eq('1/12', padIndex(1, 12), '01');
eq('12/12', padIndex(12, 12), '12');
eq('1/120', padIndex(1, 120), '001');
eq('7/1（最少 2 位）', padIndex(7, 1), '07');

/* ------------------------------------------------------------ */
/* 5. 镜头行 + 总时长                                            */
/* ------------------------------------------------------------ */
section('5. buildShotRows / totalDuration —— 累计起止时间');
const shots = [
  { id: 'a', label: '全景 · 推近', duration: 2, cam: { r: 16, phi: 1.05, theta: 0.85, t: [0, 1.2, 0], fov: 45 }, ease: 'easeInOut' },
  { id: 'b', duration: 3.5 },
  { id: 'c', label: '特写', duration: 0.4, ease: 'linear' }
];
const rows = buildShotRows(shots);
eq('行数', rows.length, 3);
eq('第 1 个镜头 index', rows[0].index, 1);
eq('第 1 个镜头 start/end', [rows[0].start, rows[0].end], [0, 2]);
eq('第 2 个镜头 start/end', [rows[1].start, rows[1].end], [2, 5.5]);
eq('第 3 个镜头 start/end', [rows[2].start, rows[2].end], [5.5, 5.9]);
eq('缺 label 时补「镜头 N」', rows[1].label, '镜头 2');
eq('缺 id 时补 shot_N', buildShotRows([{ duration: 1 }])[0].id, 'shot_1');
eq('有 id 时原样保留', rows[0].id, 'a');
eq('cam 透传', rows[0].cam.r, 16);
eq('ease 透传', rows[2].ease, 'linear');
eq('缺 ease 时为 null', rows[1].ease, null);
eq('总时长', totalDuration(shots), 5.9);
eq('空数组总时长', totalDuration([]), 0);

/* ------------------------------------------------------------ */
/* 6. 接触表版式                                                 */
/* ------------------------------------------------------------ */
section('6. computeSheetLayout —— 接触表版式（1600px 宽 / 24px 内边距 / 4 列 / 16:9）');
const L8 = computeSheetLayout(8);
eq('宽度固定 1600', L8.width, 1600);
eq('8 镜头 4 列 2 行', [L8.cols, L8.rows], [4, 2]);
eq('格子宽 (1600-48-3×18)/4', L8.cellW, 374.5);
eq('缩略图高（16:9 取整）', L8.thumbH, 211);
eq('格子高 = 缩略图 + 标签区', L8.cellH, 269);
eq('整张高度（2 行）', L8.height, 734);
const L0 = computeSheetLayout(0);
eq('0 镜头高度（页眉 + 页脚）', L0.height, 178);
const L1 = computeSheetLayout(1);
eq('1 镜头只有 1 列', [L1.cols, L1.rows], [1, 1]);
eq('1 镜头格子更宽', Math.round(L1.cellW * 100) / 100, 1552);
const L9 = computeSheetLayout(9);
eq('9 镜头 3 行高度', L9.height, 1021);

/* ------------------------------------------------------------ */
/* 7. 导出文件名                                                 */
/* ------------------------------------------------------------ */
section('7. 导出文件名');
eq('接触表文件名', storyboardFileName({ title: '屋顶追逐 / 第1版' }), '屋顶追逐-第1版_storyboard.png');
eq('接触表文件名（无标题）', storyboardFileName({}), '未命名分镜_storyboard.png');
eq('清单 JSON 文件名', shotListFileName({ title: '广告片A' }, 'json'), '广告片A_shots.json');
eq('清单 CSV 文件名', shotListFileName({ title: '广告片A' }, 'csv'), '广告片A_shots.csv');
eq('序列单张文件名', packFileName({ index: 1, label: '推近: 主角' }, 12), '01_推近-主角.png');
eq('序列三位序号', packFileName({ index: 12, label: '拉远' }, 120), '012_拉远.png');

/* ------------------------------------------------------------ */
/* 8. JSON 清单结构                                              */
/* ------------------------------------------------------------ */
section('8. buildShotListPayload —— 镜头清单 JSON 结构');
const payload = buildShotListPayload(shots, { title: '屋顶追逐', subtitle: '第 2 版' });
eq('schema', payload.schema, 'whitebox.storyboard/1');
eq('shotCount', payload.shotCount, 3);
eq('totalDuration', payload.totalDuration, 5.9);
eq('title', payload.title, '屋顶追逐');
eq('subtitle', payload.subtitle, '第 2 版');
eq('每镜头字段齐全', Object.keys(payload.shots[0]).sort(), [
  'cam', 'duration', 'ease', 'end', 'endTimecode', 'id', 'index', 'label', 'start', 'startTimecode'
].sort());
eq('第 1 镜 startTimecode', payload.shots[0].startTimecode, '00:00.0');
eq('第 2 镜 startTimecode', payload.shots[1].startTimecode, '00:02.0');
eq('第 3 镜 endTimecode', payload.shots[2].endTimecode, '00:05.9');
eq('cam 原样保留', payload.shots[0].cam, { r: 16, phi: 1.05, theta: 0.85, t: [0, 1.2, 0], fov: 45 });

/* ------------------------------------------------------------ */
/* 9. CSV                                                        */
/* ------------------------------------------------------------ */
section('9. buildCSV —— UTF-8 BOM + CRLF + 转义');
const csv = buildCSV(shots, { title: '屋顶追逐' });
ok('以 UTF-8 BOM 开头（Excel 中文不乱码）', csv.charCodeAt(0) === 0xFEFF, 'U+FEFF');
ok('使用 CRLF 换行', csv.includes('\r\n'));
ok('表头含中文列名', csv.split('\r\n')[0].includes('序号,镜头名,时长(s),开始时间码,结束时间码'), csv.split('\r\n')[0]);
eq('数据行数（表头 + 3 镜头）', csv.split('\r\n').filter(Boolean).length, 4);
ok('时长保留 3 位小数', csv.includes('2.000,00:00.0,00:02.0'));
const csvEsc = buildCSV([{ label: 'a,b"c', duration: 1, cam: { r: 8 } }, { label: '换行\n名' }], {});
ok('逗号/引号被正确转义', csvEsc.includes('"a,b""c"'));
ok('换行被引号包裹（合法 CSV 多行单元格）', csvEsc.includes('"换行') && csvEsc.includes('名"'));
eq('空镜头只有表头', buildCSV([], {}).split('\r\n').filter(Boolean).length, 1);
eq('cam 缺失时留空列', buildCSV([{ label: 'x', duration: 1 }], {}).split('\r\n')[1].split(',')[5], '');

/* ------------------------------------------------------------ */
/* 10. 边界与失败显性化                                          */
/* ------------------------------------------------------------ */
section('10. 边界行为');
eq('shots 传 null 不炸', buildShotRows(null).length, 0);
eq('shots 传 null 的 CSV 表头仍在', buildCSV(null, {}).split('\r\n').filter(Boolean).length, 1);
eq('duration 负数夹到 0', buildShotRows([{ duration: -5 }])[0].duration, 0);
eq('duration 字符串转数字', buildShotRows([{ duration: '2.5' }])[0].duration, 2.5);
ok('exportContactSheet 在 Node 里显性失败（需要浏览器）',
  await m.exportContactSheet({ shots: [], renderShot: () => Promise.resolve('data:,') })
    .then(() => false).catch(e => /浏览器/.test(e.message)));

/* ------------------------------------------------------------ */
/* 汇总                                                          */
/* ------------------------------------------------------------ */
console.log('\n' + '─'.repeat(60));
if (fail) {
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('\n失败明细：');
  failures.forEach(f => console.log('  • ' + f));
  process.exitCode = 1;
} else {
  console.log(`结果：${pass} 项断言全部通过，0 失败`);
}
