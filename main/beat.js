'use strict';
// Beat finder for the edge glow: given a few seconds of mono audio, estimates the
// tempo and where the beats fall. Small and dependency-free: an onset envelope
// (rises in loudness, low band weighted), autocorrelation for the tempo, then a
// comb over the envelope for the phase. Runs in well under 50 ms for 8 s of audio.
//
//   analyze(samples, rate, { priorBpm, nearBpm }) -> { bpm, phaseSec, confidence } | null
//
// priorBpm: a tempo guess from the online lookup; it decides between competing
//           candidates (it's often double or half the felt tempo, which is fine).
// nearBpm:  a tempo we already trust (rechecks); only look within ±3% of it.

const HOP = 128;              // samples per envelope frame
const MIN_BPM = 50;
const MAX_BPM = 210;
const MIN_CONFIDENCE = 0.45;  // winning tempo must stand out from the rest...
const MIN_STRENGTH = 0.5;     // ...and repeat strongly; else "no clear beat" (speech, ambient, silence)

function envelope(x, rate) {
  const frames = Math.floor(x.length / HOP);
  const a = Math.exp((-2 * Math.PI * 150) / rate); // one-pole low-pass ~150 Hz for the kick
  let lp = 0;
  const eFull = new Float64Array(frames);
  const eLow = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sFull = 0;
    let sLow = 0;
    for (let i = f * HOP, end = i + HOP; i < end; i++) {
      const v = x[i];
      lp = a * lp + (1 - a) * v;
      sFull += v * v;
      sLow += lp * lp;
    }
    eFull[f] = Math.log(1e-12 + sFull / HOP);
    eLow[f] = Math.log(1e-12 + sLow / HOP);
  }
  // Onset strength: how much louder than the frame before, low band counted double.
  const o = new Float64Array(frames);
  for (let f = 1; f < frames; f++) {
    o[f] = Math.max(0, eLow[f] - eLow[f - 1]) * 2 + Math.max(0, eFull[f] - eFull[f - 1]);
  }
  // Remove the slow-moving average so only peaks remain.
  const fps = rate / HOP;
  const w = Math.max(1, Math.round(fps * 0.4));
  const out = new Float64Array(frames);
  let sum = 0;
  for (let f = 0; f < frames; f++) {
    sum += o[f];
    if (f >= w) sum -= o[f - w];
    out[f] = Math.max(0, o[f] - sum / Math.min(f + 1, w));
  }
  return { o: out, fps };
}

function autocorr(o, lag) {
  const n = o.length;
  let s = 0;
  const i0 = Math.floor(lag);
  const frac = lag - i0;
  for (let i = 0; i + i0 + 1 < n; i++) s += o[i] * (o[i + i0] * (1 - frac) + o[i + i0 + 1] * frac);
  return s / (n - i0);
}

function analyze(samples, rate, { priorBpm = 0, nearBpm = 0 } = {}) {
  if (!samples || samples.length < rate * 3) return null;
  const { o, fps } = envelope(samples, rate);
  const r0 = autocorr(o, 0);
  if (!(r0 > 0)) return null;

  const lo = nearBpm ? nearBpm * 0.97 : MIN_BPM;
  const hi = nearBpm ? nearBpm * 1.03 : MAX_BPM;
  // Score each tempo by its autocorrelation plus half of the one at twice the period
  // (real beats repeat at both); 0.25 BPM steps.
  const score = (bpm) => {
    const lag = (60 * fps) / bpm;
    return autocorr(o, lag) + 0.5 * autocorr(o, lag * 2);
  };
  const cands = [];
  for (let bpm = lo; bpm <= hi; bpm += 0.25) cands.push({ bpm, s: score(bpm) / r0 });

  // Local peaks only, so a broad hump counts once.
  const peaks = cands.filter((c, i) => i > 0 && i < cands.length - 1 && c.s >= cands[i - 1].s && c.s >= cands[i + 1].s);
  if (!peaks.length) return null;
  const weight = (bpm) => {
    if (nearBpm) return 1;
    // Gentle preference for common tempos (centred on 115), stronger near the online guess.
    let w = Math.exp(-0.5 * (Math.log2(bpm / 115) / 1.0) ** 2);
    if (priorBpm) {
      const rel = [1, 0.5, 2].map((m) => Math.abs(Math.log2(bpm / (priorBpm * m))));
      if (Math.min(...rel) < 0.04) w *= 1.6;
    }
    return w;
  };
  let best = peaks[0];
  for (const p of peaks) if (p.s * weight(p.bpm) > best.s * weight(best.bpm)) best = p;
  // Confidence: how far the winning tempo stands out from a typical tempo's score.
  // A steady beat gives one tall peak; noise, speech and pads give a flat curve.
  const sorted = cands.map((c) => c.s).sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  const confidence = Math.max(0, Math.min(1, (best.s - median) / (best.s + 1e-9)));
  // Strength: autocorrelation at the beat period relative to the signal itself.
  // Noise and slow pads stay under ~0.45; music with a beat is well above.
  const strength = best.s;
  // In a recheck the search window is too narrow for the peak-vs-median test.
  const clear = strength >= MIN_STRENGTH && (nearBpm > 0 || confidence >= MIN_CONFIDENCE);
  if (!clear) return { bpm: best.bpm, phaseSec: 0, confidence, strength, clear: false };

  // Phase: the offset whose comb (every beat period) collects the most onset.
  const period = (60 * fps) / best.bpm;
  let bestPhase = 0;
  let bestSum = -1;
  const steps = Math.ceil(period * 2);
  for (let k = 0; k < steps; k++) {
    const ph = (k / steps) * period;
    let s = 0;
    for (let t = ph; t < o.length; t += period) {
      const i = Math.round(t);
      s += o[i] + 0.5 * ((o[i - 1] || 0) + (o[i + 1] || 0));
    }
    if (s > bestSum) {
      bestSum = s;
      bestPhase = ph;
    }
  }
  // Onset frames mark the rise just after the hit; step back half a frame.
  const phaseSec = Math.max(0, (bestPhase - 0.5) / fps);
  return { bpm: best.bpm, phaseSec, confidence, strength, clear: true };
}

module.exports = { analyze, MIN_CONFIDENCE };
