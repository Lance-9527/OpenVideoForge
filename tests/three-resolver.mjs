/* three 解析器（测试专用，不改产品代码）
 *
 * 产品在浏览器里靠 index.html 的 importmap 把 'three' → './assets/three.module.js'；
 * node 没有 importmap，所以这里用 module.register 补一个等价解析：
 *   ① 'three' → assets/three.module.js
 *   ② 去掉 './x.js?v=76' 这类缓存串（node 的 ESM 解析对查询串不稳）
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./three-loader.mjs', pathToFileURL('./tests/'));
