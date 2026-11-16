/* ============================================================================
 * server/paths.mjs —— 默认目录（跨平台，不写死任何人的本机路径）
 *
 * ★ 为什么要有这一层（2026-11-16 开源时整理）：
 *   之前的默认值写死成开发机上的盘符路径（产物目录与数据目录）——
 *   那是开发机的路径，别人装上就指到不存在的地方（而且暴露了本机目录结构）。
 *   现在统一成：**环境变量优先 → 否则用系统标准的用户目录**。
 *
 *   · 产物目录：WBWB_OUT_DIR  → <用户目录>/Downloads/OpenVideoForge
 *   · 数据目录：VIDEOFORGE_DATA_DIR → <用户目录>/.videoforge
 * ========================================================================== */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 产物目录名。 */
export const OUT_DIR_NAME = 'OpenVideoForge';

/**
 * 默认产物目录（模型、渲染产物、导出文件都落这儿）。
 * @returns {string} 绝对路径。
 */
export function defaultOutDir() {
  return path.join(os.homedir(), 'Downloads', OUT_DIR_NAME);
}

/**
 * 默认业务数据目录（VideoForge 的项目 / 分镜 / 成片数据）。
 * @returns {string} 绝对路径。
 */
export function defaultDataDir() {
  return path.join(os.homedir(), '.videoforge');
}

/**
 * 默认截图/验收产物目录（验收脚本的输出都落这儿）。
 * @returns {string} 绝对路径。
 */
export function defaultShotsDir() {
  return path.join(defaultOutDir(), 'shots');
}

/**
 * 默认的第三方工具存放目录（Blender 便携版等）。
 * @returns {string} 绝对路径。
 */
export function defaultToolsDir() {
  return process.env.OVF_TOOLS_DIR || path.join(os.homedir(), 'Tools');
}

/**
 * 默认的临时浏览器 profile 目录（自动化验收用）。
 * @param {string} name 子目录名。
 * @returns {string} 绝对路径。
 */
export function defaultProfileDir(name) {
  return path.join(os.tmpdir(), name);
}

/**
 * 找一个可用的 Blender 可执行文件。
 *
 * ★ 查找顺序：环境变量 → PATH → 常见安装位置。
 *   以前写死了开发机上的便携版位置（别人机器上根本不存在）。
 *
 * @param {NodeJS.Platform} [platform] 平台（默认当前平台）。
 * @returns {string|null} 找到的路径；找不到返回 null。
 */
export function findBlender(platform = process.platform) {
  const fromEnv = process.env.VIDEOFORGE_BLENDER || process.env.BLENDER_PATH;
  if (fromEnv) return fromEnv;
  const candidates = platform === 'win32'
    ? [
      'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
      'C:\\Program Files\\Blender Foundation\\Blender\\blender.exe',
      'C:\\Program Files (x86)\\Blender Foundation\\Blender 4.2\\blender.exe',
    ]
    : ['/usr/bin/blender', '/usr/local/bin/blender', '/opt/blender/blender'];
  return candidates.find((p) => existsSync(p)) || null;
}
