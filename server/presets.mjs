/* ============================================================================
 * server/presets.mjs —— 预设库（存到本机，可随时调出来）
 *
 * 一个预设 = 一个能复现的画面：
 *   { version, name, spec, env, size, camera, light, assets, thumb, attribution, createdAt }
 *
 * 存在 <OUT_DIR>\预设库\*.json，纯本地、可拷可删、可版本控制。
 * 预设里还带 **出处/署名**（比如 OSM 的 © OpenStreetMap contributors），
 * 出图时一起带出去 —— 这样素材的可追溯性不丢。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { defaultOutDir } from './paths.mjs';

export const PRESET_DIR_NAME = '预设库';

export function presetDir(outDir) {
  const d = path.join(outDir || process.env.WBWB_OUT_DIR || defaultOutDir(), PRESET_DIR_NAME);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 文件名安全化：只留字母数字下划线连字符和中文 */
export function safeId(name) {
  const s = String(name || 'preset')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 48) || 'preset';
  return s;
}

function fileOf(id) {
  const s = safeId(id);
  if (!/^[\w一-龥.-]+$/.test(s)) return null;
  return s + '.json';
}

/** 保存一个预设（同名覆盖） */
export function savePreset(data, outDir) {
  const dir = presetDir(outDir);
  const id = safeId(data.id || data.name);
  const now = new Date().toISOString();
  const rec = {
    version: 1,
    id,
    name: String(data.name || id),
    note: data.note || '',
    spec: data.spec || null,
    env: data.env || null,
    size: data.size || null,
    camera: data.camera || null,
    light: data.light || null,
    assets: Array.isArray(data.assets) ? data.assets : [],
    interior: !!data.interior,
    attribution: data.attribution || (data.spec && data.spec.attribution) || null,
    source: data.source || (data.spec && data.spec.kind) || null,
    thumb: data.thumb || null,
    createdAt: now,
    updatedAt: now,
  };
  const p = path.join(dir, fileOf(id));
  if (!p) return { ok: false, error: '预设名不合法' };
  fs.writeFileSync(p, JSON.stringify(rec, null, 2), 'utf8');
  return { ok: true, preset: rec, path: p };
}

/** 读一个 */
export function readPreset(id, outDir) {
  const dir = presetDir(outDir);
  const f = fileOf(id);
  if (!f) return { ok: false, error: '预设 id 不合法' };
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) return { ok: false, error: '没有这个预设：' + id };
  try {
    return { ok: true, preset: JSON.parse(fs.readFileSync(p, 'utf8')), path: p };
  } catch (e) {
    return { ok: false, error: '预设文件读不出来：' + String((e && e.message) || e) };
  }
}

/** 列全部（新的在前） */
export function listPresets(outDir) {
  const dir = presetDir(outDir);
  let files = [];
  try { files = fs.readdirSync(dir); } catch (_) { files = []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({
        id: j.id || path.basename(f, '.json'),
        name: j.name || j.id,
        note: j.note || '',
        source: j.source || null,
        env: j.env || null,
        size: j.size || null,
        kind: (j.spec && j.spec.kind) || null,
        attribution: j.attribution || null,
        assets: (j.assets || []).length,
        interior: !!j.interior,
        thumb: j.thumb || null,
        camera: j.camera ? { r: j.camera.r, phi: j.camera.phi, theta: j.camera.theta } : null,
        createdAt: j.createdAt || null,
        updatedAt: j.updatedAt || null,
      });
    } catch (_) { /* 坏文件跳过 */ }
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

/** 删一个 */
export function deletePreset(id, outDir) {
  const dir = presetDir(outDir);
  const f = fileOf(id);
  if (!f) return { ok: false, error: '预设 id 不合法' };
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) return { ok: false, error: '没有这个预设：' + id };
  fs.unlinkSync(p);
  return { ok: true, deleted: id };
}

/** 改名 / 改备注 */
export function updatePreset(id, patch, outDir) {
  const r = readPreset(id, outDir);
  if (!r.ok) return r;
  const rec = r.preset;
  if (patch.name) rec.name = String(patch.name);
  if (patch.note !== undefined) rec.note = String(patch.note || '');
  rec.updatedAt = new Date().toISOString();
  const p = path.join(presetDir(outDir), fileOf(rec.id));
  fs.writeFileSync(p, JSON.stringify(rec, null, 2), 'utf8');
  return { ok: true, preset: rec, path: p };
}
