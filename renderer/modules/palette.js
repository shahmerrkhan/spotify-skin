// Colors from the album art, in OKLab so lightness and chroma behave predictably.
// The cover is shrunk to 32x32 and its pixels sorted into 12 hue bins plus one
// neutral bin. Dominant = the busiest bin; accents = the most vivid busy bins,
// pushed into a range that reads as neon on dark glass.

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function rgbToOklab(r, g, b) {
  const R = toLinear(r / 255), G = toLinear(g / 255), B = toLinear(b / 255);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

// Mean OKLab lightness of RGBA pixel data.
export function meanLightness(data) {
  let sum = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += rgbToOklab(data[i], data[i + 1], data[i + 2])[0];
    n++;
  }
  return n ? sum / n : 0;
}

const hueDist = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f = (n, d = 3) => n.toFixed(d);

export function extract(img) {
  const c = new OffscreenCanvas(32, 32);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 32, 32);
  const { data } = ctx.getImageData(0, 0, 32, 32);

  const bins = Array.from({ length: 13 }, () => ({ n: 0, L: 0, a: 0, b: 0, C: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    const [L, a, b] = rgbToOklab(data[i], data[i + 1], data[i + 2]);
    const C = Math.hypot(a, b);
    const neutral = C < 0.045 || L < 0.12 || L > 0.97;
    const h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
    const bin = bins[neutral ? 12 : Math.floor(h / 30) % 12];
    bin.n++; bin.L += L; bin.a += a; bin.b += b; bin.C += C;
  }
  const mean = (bin) => {
    const L = bin.L / bin.n, a = bin.a / bin.n, b = bin.b / bin.n;
    return { L, C: Math.hypot(a, b), h: (Math.atan2(b, a) * 180 / Math.PI + 360) % 360, n: bin.n, Cmean: bin.C / bin.n };
  };

  const used = bins.filter((b) => b.n > 0);
  const dominant = mean(used.reduce((best, b) => (b.n > best.n ? b : best)));
  const vivid = bins.slice(0, 12).filter((b) => b.n >= 3).map(mean)
    .sort((x, y) => (y.n ** 0.6) * y.Cmean - (x.n ** 0.6) * x.Cmean);

  const accent = vivid[0] || null;
  const accent2 = accent ? vivid.find((v) => hueDist(v.h, accent.h) >= 45) || null : null;
  return { dominant, accent, accent2 };
}

// CSS custom properties for a palette (or the neutral fallback when p is null).
export function toCss(p) {
  if (!p) {
    return {
      '--dominant': 'oklch(0.24 0.02 300)', '--accent': 'oklch(0.78 0.12 350)', '--accent-2': 'oklch(0.72 0.12 290)',
      '--glow-3': 'oklch(0.6 0.13 320)',
      '--ink': 'oklch(0.97 0.012 300)', '--clock': 'oklch(0.93 0.04 320)', '--clock-dark': 'oklch(0.27 0.05 300)',
    };
  }
  const d = p.dominant;
  const dh = d.C > 0.02 ? d.h : (p.accent?.h ?? 70);
  const neon = (v, Lmin, Lmax) => `oklch(${f(clamp(v.L, Lmin, Lmax))} ${f(clamp(v.C, 0.09, 0.19))} ${f(v.h, 1)})`;
  // Grey covers get a quiet warm accent instead of an invented colour.
  const acc = p.accent ? neon(p.accent, 0.72, 0.84) : `oklch(0.84 0.03 ${f(dh, 1)})`;
  const acc2 = p.accent2
    ? neon(p.accent2, 0.68, 0.82)
    : p.accent ? `oklch(${f(clamp(p.accent.L, 0.66, 0.8))} ${f(clamp(p.accent.C, 0.09, 0.17))} ${f((p.accent.h + 40) % 360, 1)})`
      : `oklch(0.72 0.03 ${f((dh + 30) % 360, 1)})`;
  const ah = p.accent?.h ?? dh;
  return {
    '--dominant': `oklch(${f(Math.min(d.L, 0.32))} ${f(Math.min(d.C, 0.12))} ${f(dh, 1)})`,
    '--accent': acc,
    '--accent-2': acc2,
    // Third glow colour: the cover's main colour, lit up; deeper than the accents for contrast.
    '--glow-3': `oklch(0.6 ${f(clamp(d.C * 1.8, 0.08, 0.16))} ${f(dh, 1)})`,
    '--ink': `oklch(0.97 ${f(Math.min(d.C, 0.02))} ${f(dh, 1)})`,
    '--clock': `oklch(0.93 ${f(Math.min(p.accent?.C ?? 0.02, 0.06))} ${f(ah, 1)})`,
    '--clock-dark': `oklch(0.27 ${f(clamp(d.C, 0.03, 0.08))} ${f(dh, 1)})`,
  };
}
