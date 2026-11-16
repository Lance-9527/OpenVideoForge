/* 配套 three-resolver.mjs 的解析钩子 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function resolve(specifier, context, next) {
  // ① 裸 'three' → 项目自带的 three
  if (specifier === 'three') {
    return { url: pathToFileURL(path.join(ROOT, 'assets', 'three.module.js')).href, shortCircuit: true };
  }
  // ② 相对路径上的 ?v=NN 缓存串：去掉再解析
  const q = specifier.indexOf('?');
  if (q > 0 && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const clean = specifier.slice(0, q);
    try {
      return await next(clean, context);
    } catch (e) {
      return next(specifier, context);
    }
  }
  return next(specifier, context);
}
