/* ==========================================================================
 * save-file.js · 让页面里所有「下载」都落到固定文件夹（v1.9）
 *
 * 浏览器不允许网页指定下载目录，所以走本地 Agent 桥：
 *   页面任何 a[download].click()（图片/视频/CSV/JSON/分镜表 PNG…）
 *   → 拦截 → 读出 blob → POST http://127.0.0.1:8787/save {name, base64}
 *   → 桥写进 <输出目录>\ → 页面 toast 显示真实路径
 * 桥不在线时自动退回浏览器默认下载（行为不变）。
 * ========================================================================== */
(function () {
  'use strict';

  const PORT = window.WB_BRIDGE_PORT || 8787;
  const BASE = 'http://127.0.0.1:' + PORT;
  let bridgeOk = null;      // null=未知, true/false
  let detectedAt = 0;

  function toast(msg, kind) {
    const box = document.getElementById('toasts');
    if (!box) { console.log('[save]', msg); return; }
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || 'ok');
    t.textContent = msg;
    box.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3600);
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result || '');
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  async function detect() {
    if (bridgeOk !== null && Date.now() - detectedAt < (bridgeOk ? 10000 : 1500)) return bridgeOk;
    try {
      const r = await fetch(BASE + '/out', { signal: AbortSignal.timeout(1200) });
      bridgeOk = r.ok;
    } catch (_) { bridgeOk = false; }
    detectedAt = Date.now();
    return bridgeOk;
  }

  /** 统一的保存入口：dataURL / blobURL / Blob 都行 */
  async function save(src, filename) {
    const name = filename || ('白膜输出_' + Date.now());
    const ok = await detect();
    if (!ok) return { ok: false, fallback: true };
    try {
      let blob;
      if (typeof src === 'string') {
        const r = await fetch(src);
        blob = await r.blob();
      } else if (src instanceof Blob) {
        blob = src;
      } else {
        return { ok: false, error: '不支持的来源' };
      }
      const base64 = await blobToBase64(blob);
      const res = await fetch(BASE + '/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, base64 }),
      });
      const out = await res.json();
      if (out && out.ok) {
        toast('已保存 · ' + out.path, 'ok');
        return out;
      }
      toast('保存失败：' + ((out && out.error) || '未知'), 'warn');
      return { ok: false, error: out && out.error };
    } catch (err) {
      bridgeOk = false;
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  /* 拦截所有带 download 属性的 <a>.click() */
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      const href = this.getAttribute('href') || '';
      if (this.download && (href.startsWith('blob:') || href.startsWith('data:'))) {
        const anchor = this;
        // Keep an independent Blob URL alive while the asynchronous bridge is tried.
        Promise.resolve(fetch(href)).then(r => r.blob()).then(async blob => {
          const out = await save(blob, anchor.download);
          if (!out.ok) {
            const url = URL.createObjectURL(blob);
            const fallback = document.createElement('a');
            fallback.href = url; fallback.download = anchor.download;
            origClick.call(fallback);
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            toast('本地桥不可用，已交给浏览器下载', 'warn');
          }
        }).catch(() => { origClick.call(anchor); });
        return;
      }
    } catch (_) { /* 落到原生 */ }
    return origClick.apply(this, arguments);
  };

  /** 在资源管理器里打开输出文件夹（可选选中某个文件） */
  async function openFolder(file) {
    const ok = await detect();
    if (!ok) { toast('本地桥没启动，暂时无法打开文件夹', 'warn'); return { ok: false }; }
    try {
      const res = await fetch(BASE + '/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: file || null }),
      });
      const out = await res.json();
      if (out && out.ok) toast('已打开 ' + out.opened, 'ok');
      else toast('打开失败：' + ((out && out.error) || '未知'), 'warn');
      return out;
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  window.WBSave = { save, openFolder, detect, get bridge() { return BASE; } };

  // 启动时探一次，把输出目录显示在控制台，方便排查
  detect().then((ok) => {
    if (!ok) return;
    fetch(BASE + '/out').then(r => r.json()).then(j => {
      console.log('[save] 输出目录 =', j.outDir);
    }).catch(() => {});
  });
})();
