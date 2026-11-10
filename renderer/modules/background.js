// The background: album art, lightly blurred, with a dark vignette. Rendered once
// per song onto a canvas: the pixels go straight to one of two on-screen canvases
// (they crossfade), and a JPEG of the same image goes to the main process as the
// real XFCE wallpaper. Bitmaps are handed over and freed explicitly, so nothing
// piles up in Chromium's image cache from song to song.

import { meanLightness } from './palette.js';

const BLUR_PX = 14;
const OVERSCAN = 1.06; // hides the soft edge the blur leaves at the borders

// Where the clock sits, as fractions of the screen: top right (playing) and centre (idle, 1.35x).
const REGIONS = {
  top: { x0: 0.62, x1: 0.97, y0: 0.03, y1: 0.35 },
  center: { x0: 0.28, x1: 0.72, y0: 0.22, y1: 0.66 },
};

export async function renderBackdrop(img, w, h) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const s = Math.max(w / iw, h / ih) * OVERSCAN;
  const dw = iw * s;
  const dh = ih * s;
  ctx.fillStyle = '#0c0b0a';
  ctx.fillRect(0, 0, w, h);
  ctx.filter = `blur(${BLUR_PX}px)`;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.filter = 'none';

  // Dark vignette, slightly heavier at the bottom where the dock and title sit.
  const g = ctx.createRadialGradient(w / 2, h * 0.42, Math.min(w, h) * 0.3, w / 2, h * 0.42, Math.hypot(w, h) * 0.62);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.72)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const floor = ctx.createLinearGradient(0, h * 0.55, 0, h);
  floor.addColorStop(0, 'rgba(0,0,0,0)');
  floor.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, h * 0.55, w, h * 0.45);

  // Brightness behind the clock, measured on the finished image.
  const probe = new OffscreenCanvas(48, 27);
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(canvas, 0, 0, 48, 27);
  const light = {};
  for (const [k, r] of Object.entries(REGIONS)) {
    const x = Math.round(r.x0 * 48), y = Math.round(r.y0 * 27);
    const data = pctx.getImageData(x, y, Math.max(1, Math.round((r.x1 - r.x0) * 48)), Math.max(1, Math.round((r.y1 - r.y0) * 27))).data;
    light[k] = meanLightness(data);
  }

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const bitmap = canvas.transferToImageBitmap(); // moves the pixels out, no copy
  return { blob, bitmap, light };
}

export class Backdrop {
  constructor(a, b) {
    this.layers = [a, b].map((canvas) => ({ canvas, ctx: canvas.getContext('bitmaprenderer') }));
    this.front = 0;
    this.timer = 0;
  }

  // Takes ownership of the bitmap.
  show(bitmap) {
    const next = 1 - this.front;
    const old = this.front;
    const layer = this.layers[next];
    layer.ctx.transferFromImageBitmap(bitmap);
    layer.canvas.classList.add('is-on');
    this.layers[old].canvas.classList.remove('is-on');
    this.front = next;
    // Free the old pixels once the crossfade is done.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._release(old), 700);
  }

  clear() {
    clearTimeout(this.timer);
    for (const l of this.layers) l.canvas.classList.remove('is-on');
    this.timer = setTimeout(() => { this._release(0); this._release(1); }, 700);
  }

  _release(i) {
    const l = this.layers[i];
    if (!l.canvas.classList.contains('is-on')) l.ctx.transferFromImageBitmap(null);
  }
}
