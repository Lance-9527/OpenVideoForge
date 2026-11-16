/* ==========================================================================
 * server/share.mjs —— 分享场景（**短链接**）
 *
 * ★ 2026-11-09：原来的分享是「状态即链接」—— 整个场景 base64url 塞进 URL。
 *   问题：大场景链接会爆长（实测 40 个物体 = 6315 字符；
 *   100 个物体就 15K+）。微信/Slack/邮件客户端对 URL 长度限制各异，
 *   超过 ~8000 就可能点不开。
 *
 * 做法：场景存到**本地磁盘**，链接只带一个短 id：
 *   <OUT_DIR>\分享\<id>.json
 *   链接：index.html?s=<id>
 *
 *   · 链接恒定短（几十个字符）
 *   · 场景可以**删**（分享出去后能撤回）
 *   · 默认 7 天过期（可配）
 *   · 状态是**本机**的 —— 对方得能访问这台机器（局域网/隧道）才行，
 *     所以仍然保留原来的 base64 内联模式作为**兜底**（离线可分享）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SUBDIR = path.join('素材库', '分享');
const DEFAULT_TTL_DAYS = 7;

export function shareDir(outDir) {
  return path.join(outDir, SUBDIR);
}

/** 存一个场景，返回短 id */
export function shareSave(state, outDir, opt = {}) {
  if (!state || typeof state !== 'object') return { ok: false, error: '缺少场景状态' };
  const dir = shareDir(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const id = String(opt.id || crypto.randomBytes(9).toString('base64url'));
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return { ok: false, error: '非法 id' };
  const ttlDays = Number.isFinite(Number(opt.ttlDays)) ? Number(opt.ttlDays) : DEFAULT_TTL_DAYS;
  const rec = {
    id,
    state,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlDays * 86400000).toISOString(),
    ttlDays,
  };
  const file = path.join(dir, id + '.json');
  fs.writeFileSync(file, JSON.stringify(rec), 'utf8');
  return { ok: true, id, bytes: fs.statSync(file).size, expiresAt: rec.expiresAt, dir };
}

/** 取一个场景（过期了就说过期） */
export function shareLoad(id, outDir) {
  const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) return { ok: false, error: '缺少 id' };
  const file = path.join(shareDir(outDir), safe + '.json');
  if (!fs.existsSync(file)) return { ok: false, error: '这个分享不存在（可能已删除或已过期）' };
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { ok: false, error: '分享数据坏了' }; }
  if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now()) {
    return { ok: false, error: '这个分享已过期', expired: true };
  }
  return { ok: true, id: safe, state: rec.state, createdAt: rec.createdAt, expiresAt: rec.expiresAt };
}

/** 删一个分享（撤回） */
export function shareDelete(id, outDir) {
  const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  const file = path.join(shareDir(outDir), safe + '.json');
  if (!fs.existsSync(file)) return { ok: false, error: '没有这个分享' };
  fs.unlinkSync(file);
  return { ok: true, id: safe };
}

/** 列出所有分享（管理用） */
export function shareList(outDir) {
  const dir = shareDir(outDir);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (_) { names = []; }
  const items = [];
  for (const n of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      items.push({
        id: rec.id, createdAt: rec.createdAt, expiresAt: rec.expiresAt,
        assets: rec.state && rec.state.assets ? rec.state.assets.length : 0,
        bytes: fs.statSync(path.join(dir, n)).size,
      });
    } catch (_) { /* 跳过坏文件 */ }
  }
  return { ok: true, count: items.length, items, dir };
}

/** 清理过期的 */
export function sharePrune(outDir) {
  const dir = shareDir(outDir);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (_) { names = []; }
  let removed = 0;
  for (const n of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now()) {
        fs.unlinkSync(path.join(dir, n));
        removed++;
      }
    } catch (_) { /* 跳过 */ }
  }
  return { ok: true, removed };
}
