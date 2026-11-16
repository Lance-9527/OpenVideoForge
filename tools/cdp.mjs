/* ============================================================================
 * tools/cdp.mjs —— 零依赖 Chrome DevTools Protocol 驱动（Node 24 自带 WebSocket）
 *
 * 用途：开页面、点按钮、跑页面里的 wb_* 指令、截图。
 * 不装任何 npm 包。
 * ========================================================================== */
import http from 'node:http';

const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.CDP_PORT || 9222);

function httpJson(path, port = CDP_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: CDP_HOST, port, path }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('CDP HTTP timeout')); });
  });
}

/** 找到 openvideoforge 那个页面 target */
export async function findPage(match = 'index.html', port = CDP_PORT) {
  const list = await httpJson('/json', port);
  const pages = (list || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('没有可用的 page target');
  const hit = pages.find((t) => (t.url || '').includes(match)) || pages[0];
  return hit;
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    });
  }

  /**
   * 连到某个页面。
   * @param {string} match  URL 里要包含的片段
   * @param {object} opt    { port }  —— 连别的浏览器实例（比如独立 profile）
   */
  static async attach(match, opt = {}) {
    const t = await findPage(match, opt.port || CDP_PORT);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
        // ★ 2026-11-10：原来 120 秒。设备出图（device.shoot）会跑真实渲染，
        //   120 秒不够 ⇒ 超时把 CDP 会话打断，后面所有调用一起挂。
        //   放宽到 10 分钟（验收脚本本来就该允许慢操作）。
      }, 600000);
    });
  }

  /** 在页面里跑表达式，返回 JSON 值 */
  async eval(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const e = r.exceptionDetails;
      throw new Error('页面异常: ' + (e.exception?.description || e.text || JSON.stringify(e)));
    }
    return r.result?.value;
  }

  async screenshot(file, { width = 1600, height = 900, clip = null, scale = 1 } = {}) {
    const fs = await import('node:fs');
    const params = { format: 'png', captureBeyondViewport: false };
    // ★ 支持裁剪区域（比对两个视图时用）：clip = {x,y,width,height}
    if (clip) {
      params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale || scale };
    }
    const r = await this.send('Page.captureScreenshot', params);
    fs.mkdirSync(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  async close() { try { this.ws.close(); } catch (_) {} }
}
