/* ==========================================================================
 * grade-pipeline.js · 成片管线（预览 / 导出共用，v1.5）
 *
 * 之前「小窗是成片、导出只是调色」两处漂移，这里抽成一条共用管线：
 *   基础调色 → 辉光 halation → 电影调色（暖高光/冷阴影）→ 暗角 → 胶片颗粒 → 画幅遮幅
 *
 * 用法（不依赖 ES module，供经典脚本和 module 一起用）：
 *   FilmGrade.apply(ctx2d, srcCanvas, w, h, opts)
 *   opts: { contrast, saturation, bloom(0..1), grain(0..1), vignette(0..1),
 *           letterbox: null|'2.39'|'2.0'|'1.85', warmth(0..1) }
 * ========================================================================== */
(function (global) {
  'use strict';

  let grainTile = null;
  function noise() {
    if (grainTile) return grainTile;
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const x = c.getContext('2d');
    const img = x.createImageData(96, 96);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 190 + Math.random() * 65;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    grainTile = c;
    return c;
  }

  const DEFAULTS = {
    contrast: 1,
    saturation: 1,
    bloom: 0.30,
    grain: 0.085,
    vignette: 0,
    letterbox: '2.39',
    warmth: 1,
  };

  const BARS = { '2.39': 2.39, '2.0': 2.0, '2': 2.0, '1.85': 1.85, '16:9': 16 / 9, '1.78': 16 / 9 };

  function apply(ctx, src, w, h, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    ctx.save();
    ctx.clearRect(0, 0, w, h);

    // ① 基础调色
    const c = Number(o.contrast) || 1;
    const s = Number(o.saturation) || 1;
    ctx.filter = 'contrast(' + (c * 1.12).toFixed(3) + ') saturate(' + (s * 1.22).toFixed(3) + ') brightness(1.04)';
    ctx.drawImage(src, 0, 0, w, h);
    ctx.filter = 'none';

    // ② 辉光：模糊亮部叠加（lighter）
    const bloom = Math.max(0, Math.min(1, Number(o.bloom) || 0));
    if (bloom > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.34 * bloom;
      ctx.filter = 'blur(' + Math.max(2, Math.round(w / 42)) + 'px) brightness(1.25) saturate(1.1)';
      ctx.drawImage(src, 0, 0, w, h);
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // ③ 电影调色：暖高光 + 冷阴影
    const warmth = Math.max(0, Math.min(1, o.warmth == null ? 1 : Number(o.warmth)));
    if (warmth > 0) {
      ctx.globalCompositeOperation = 'soft-light';
      const warm = ctx.createLinearGradient(0, 0, w * 0.9, h);
      warm.addColorStop(0, 'rgba(255, 206, 140, ' + (0.42 * warmth).toFixed(3) + ')');
      warm.addColorStop(0.55, 'rgba(255, 236, 210, ' + (0.12 * warmth).toFixed(3) + ')');
      warm.addColorStop(1, 'rgba(70, 120, 150, ' + (0.40 * warmth).toFixed(3) + ')');
      ctx.fillStyle = warm;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }

    // ④ 暗角：基础 0.45 起，叠加用户暗角
    const vig = Math.max(0.45, 0.55 + (Number(o.vignette) || 0) * 0.45);
    const grad = ctx.createRadialGradient(w / 2, h * 0.48, Math.min(w, h) * 0.18, w / 2, h * 0.48, Math.max(w, h) * 0.74);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.72, 'rgba(0,0,0,' + (vig * 0.28).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(0,0,0,' + (vig * 0.92).toFixed(3) + ')');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // ⑤ 胶片颗粒
    const grain = Math.max(0, Math.min(1, Number(o.grain) || 0));
    if (grain > 0) {
      const pat = ctx.createPattern(noise(), 'repeat');
      if (pat) {
        ctx.save();
        ctx.globalAlpha = grain;
        ctx.globalCompositeOperation = 'overlay';
        ctx.translate(-Math.round(Math.random() * 96), -Math.round(Math.random() * 96));
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, w + 96, h + 96);
        ctx.restore();
      }
    }

    // ⑥ 画幅遮幅
    const ar = o.letterbox ? BARS[String(o.letterbox)] : 0;
    if (ar && ar > 1.2 && h <= w) {   // 竖屏不套宽银幕遮幅
      const target = w / ar;
      const bar = Math.max(0, Math.round((h - target) / 2));
      if (bar > 1) {
        ctx.fillStyle = 'rgba(6, 5, 4, 0.94)';
        ctx.fillRect(0, 0, w, bar);
        ctx.fillRect(0, h - bar, w, bar);
      }
    }

    ctx.restore();
    return o;
  }

  /** 从编辑器读一份完整成片参数（调色 + 成片开关） */
  function fromEditor(editor) {
    const g = (editor && editor.getColorGrade && editor.getColorGrade()) || {};
    const f = (editor && editor.getFilmLook && editor.getFilmLook()) || {};
    if (f.on === false) return { off: true };
    return {
      contrast: g.contrast, saturation: g.saturation, vignette: g.vignette,
      bloom: f.bloom, grain: f.grain, letterbox: f.letterbox, warmth: f.warmth,
    };
  }

  global.FilmGrade = { apply, defaults: () => Object.assign({}, DEFAULTS), fromEditor };
})(typeof window !== 'undefined' ? window : globalThis);
