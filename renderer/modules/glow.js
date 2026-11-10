// Edge glow: a thick, soft, wavy band of the cover's colours around all four
// edges, warm peach/orange in the corners, sitting on top of the panels.
//
// Cost model (measured): anything that moves at 60 fps must be a finished picture
// that only gets slid or faded. The old glow slid a blurred SVG, which Chromium
// re-drew as it moved (~37% of a core). Here each edge is painted once per song
// onto a canvas (blur included), handed to a bitmaprenderer canvas, and then
// only transformed: drift (slide along the edge), pulse (brightness + a slight
// thickening on the beat). All of it runs on the compositor.
//
// State comes from the root classes: is-playing, is-calm (minimal state),
// anim-paused (locked/asleep/covered), reduce-motion, contrast, plus the glow
// level (data-glow) from the Aa menu.
//   playing          drift at full speed, pulse on the beat (when known)
//   paused / calm    half brightness, drift very slow, no pulse
//   covered/locked   everything stops
//   reduce motion    still colours, no drift, no pulse

const DEPTH = 150;              // band thickness in px (canvas), before the soft falloff
const DRIFT_PX_S = 80;          // how fast colours travel along the edges while playing
const SLOW_RATE = 0.2;          // drift speed factor when paused / calm
const FAST_SONG_BPM = 130;      // above this, pulse every second beat
const PULSE_SCALE = 1.14;       // band thickness at the beat (eases back to 1)
const PULSE_LOW = 0.7;          // brightness between beats (1 at the beat)
const IDLE_BRIGHTNESS = 0.85;   // when there's no pulse

const SIDES = ['top', 'right', 'bottom', 'left'];

function resolveColors(root) {
  const probe = document.createElement('span');
  probe.hidden = true;
  root.append(probe);
  const read = (v) => {
    probe.style.color = `var(${v})`;
    return getComputedStyle(probe).color;
  };
  const c = { a: read('--accent'), b: read('--accent-2'), c: read('--glow-3'), warm: read('--warm') };
  probe.remove();
  return c;
}

// One edge, drawn as if it were the top edge (edge at y = 0, depth going down),
// `len` px long, periodic every len/2 so sliding by half loops seamlessly.
function paintEdge(ctx, len, colors, phase) {
  const period = len / 2;
  const wave = (x) => DEPTH * 0.3
    + Math.sin((x / period) * Math.PI * 4 + phase) * 9
    + Math.sin((x / period) * Math.PI * 10 + phase * 1.7) * 4;
  const grad = ctx.createLinearGradient(0, 0, len, 0);
  const cycle = [colors.a, colors.b, colors.c];
  // Two identical colour cycles (one per half), shifted per edge so edges differ.
  for (let half = 0; half < 2; half++) {
    for (let i = 0; i < 3; i++) grad.addColorStop((half + i / 3) / 2, cycle[(i + Math.round(phase)) % 3]);
  }
  grad.addColorStop(1, cycle[Math.round(phase) % 3]);

  // Draw past both ends so the blur has neighbours there too (no dark seams).
  const PAD = 120;
  const area = (depthScale) => {
    ctx.beginPath();
    ctx.moveTo(-PAD, -40);
    for (let x = -PAD; x <= len + PAD; x += 16) ctx.lineTo(x, wave(x) * depthScale);
    ctx.lineTo(len + PAD, -40);
    ctx.closePath();
  };
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.4;           // atmospheric haze, kept close to the edge
  ctx.filter = 'blur(28px)';
  area(1.45);
  ctx.fill();
  ctx.globalAlpha = 0.95;          // the band itself
  ctx.filter = 'blur(11px)';
  area(1);
  ctx.fill();
  // Bright wavy core line along the band's edge.
  ctx.beginPath();
  for (let x = -PAD; x <= len + PAD; x += 8) ctx[x === -PAD ? 'moveTo' : 'lineTo'](x, wave(x));
  ctx.strokeStyle = grad;
  ctx.lineWidth = 3;
  ctx.globalAlpha = 1;
  ctx.filter = 'blur(1.2px)';
  ctx.stroke();
  ctx.strokeStyle = 'rgb(255 255 255 / 0.32)';
  ctx.lineWidth = 1.2;
  ctx.filter = 'none';
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export function createGlow({ root, el, skin }) {
  const beatEl = el.querySelector('.glow__beat');
  const edges = Object.fromEntries(SIDES.map((side) => {
    const wrap = el.querySelector(`.glow__edge--${side}`);
    const canvas = wrap.querySelector('canvas');
    return [side, { wrap, canvas, ctx: canvas.getContext('bitmaprenderer'), drift: null, pulse: null }];
  }));
  let beatAnim = null;
  let beat = { source: 'none' };
  let player = null;
  let size = { w: 0, h: 0 };
  let renderGen = 0;
  let wanted = null;
  let lastSync = '';

  const has = (c) => root.classList.contains(c);
  const playing = () => has('is-playing');
  const frozen = () => has('anim-paused');
  const still = () => has('reduce-motion');
  const lively = () => playing() && !has('is-calm');

  // Painting (once per song or resize)

  async function render() {
    const gen = ++renderGen;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    const colors = resolveColors(root);
    const out = {};
    SIDES.forEach((side, i) => {
      const horizontal = side === 'top' || side === 'bottom';
      const len = (horizontal ? w : h) * 2;
      const cw = horizontal ? len : DEPTH * 2;
      const ch = horizontal ? DEPTH * 2 : len;
      const oc = new OffscreenCanvas(cw, ch);
      const ctx = oc.getContext('2d');
      // Map "top edge" drawing coordinates onto this side.
      const D = DEPTH * 2;
      if (side === 'bottom') ctx.setTransform(1, 0, 0, -1, 0, D);
      else if (side === 'left') ctx.setTransform(0, 1, 1, 0, 0, 0);
      else if (side === 'right') ctx.setTransform(0, 1, -1, 0, D, 0);
      paintEdge(ctx, len, colors, i * 1.3);
      out[side] = oc.transferToImageBitmap();
    });
    if (gen !== renderGen) return Object.values(out).forEach((b) => b.close());
    for (const side of SIDES) {
      const e = edges[side];
      e.canvas.width = out[side].width;
      e.canvas.height = out[side].height;
      e.ctx.transferFromImageBitmap(out[side]); // takes ownership; the old bitmap is freed
    }
    if (size.w !== w || size.h !== h) {
      size = { w, h };
      restartDrift();
    }
  }

  // Drift: colours travel clockwise around the screen.

  function restartDrift() {
    for (const side of SIDES) {
      const e = edges[side];
      e.drift?.cancel();
      const horizontal = side === 'top' || side === 'bottom';
      const len = horizontal ? size.w : size.h;
      const axis = horizontal ? 'X' : 'Y';
      const forward = side === 'top' || side === 'right';
      const from = `translate${axis}(${forward ? -len : 0}px)`;
      const to = `translate${axis}(${forward ? 0 : -len}px)`;
      e.drift = e.canvas.animate([{ transform: from }, { transform: to }], {
        duration: (len / DRIFT_PX_S) * 1000, iterations: Infinity,
      });
    }
    applyMotion();
  }

  // Pulse: brightness + slight thickening, lined up with the beat when known.

  function pulsePeriod() {
    if (!beat.periodMs) return 0;
    const bpm = 60000 / beat.periodMs;
    return beat.periodMs * (bpm > FAST_SONG_BPM ? 2 : 1);
  }

  function positionNow() {
    if (!player) return 0;
    return player.status === 'Playing'
      ? player.positionMs + (Date.now() - player.positionAt) * (player.rate || 1)
      : player.positionMs;
  }

  function stopPulse() {
    beatAnim?.cancel();
    beatAnim = null;
    for (const side of SIDES) {
      edges[side].pulse?.cancel();
      edges[side].pulse = null;
    }
  }

  function syncPulse() {
    const P = pulsePeriod();
    const on = P > 0 && lively() && !still() && player?.track && beat.trackId === player.track.id;
    const key = on ? `${P}|${beat.anchorPos}|${beat.aligned}|${player.positionMs}|${player.positionAt}|${player.status}` : 'off';
    if (key === lastSync && (on ? Boolean(beatAnim) : !beatAnim)) return applyMotion();
    lastSync = key;
    stopPulse();
    if (!on) {
      beatEl.style.opacity = String(IDLE_BRIGHTNESS);
      return applyMotion();
    }
    beatEl.style.opacity = '';
    const timing = { duration: P, iterations: Infinity };
    // Bright at the beat, easing back over the first third, then resting.
    beatAnim = beatEl.animate([
      { opacity: 1, offset: 0, easing: 'cubic-bezier(0.2, 0.6, 0.4, 1)' },
      { opacity: PULSE_LOW, offset: 0.35 },
      { opacity: PULSE_LOW, offset: 1 },
    ], timing);
    for (const side of SIDES) {
      const axis = side === 'top' || side === 'bottom' ? 'Y' : 'X';
      edges[side].pulse = edges[side].wrap.animate([
        { transform: `scale${axis}(${PULSE_SCALE})`, offset: 0, easing: 'cubic-bezier(0.2, 0.6, 0.4, 1)' },
        { transform: `scale${axis}(1)`, offset: 0.35 },
        { transform: `scale${axis}(1)`, offset: 1 },
      ], timing);
    }
    // Line the cycle up: beats fall at track positions anchorPos + k * period.
    const phase = beat.aligned ? ((positionNow() - beat.anchorPos) % P + P) % P : 0;
    for (const a of [beatAnim, ...SIDES.map((s) => edges[s].pulse)]) a.currentTime = phase;
    applyMotion();
  }

  // Speed / freeze for everything that moves.
  function applyMotion() {
    const drifts = SIDES.map((s) => edges[s].drift).filter(Boolean);
    const pulses = [beatAnim, ...SIDES.map((s) => edges[s].pulse)].filter(Boolean);
    if (still()) {
      for (const a of drifts) { a.pause(); a.currentTime = 0; }
      for (const a of pulses) a.pause();
    } else if (frozen()) {
      for (const a of [...drifts, ...pulses]) a.pause();
    } else {
      for (const a of drifts) {
        a.updatePlaybackRate(lively() ? 1 : SLOW_RATE);
        a.play();
      }
      for (const a of pulses) a.play();
    }
    // Tell the app whether the beat pulse is on screen (it only listens then).
    const want = lively() && !frozen() && !still();
    if (want !== wanted) {
      wanted = want;
      skin.setGlowWanted(want);
    }
  }

  new MutationObserver(() => syncPulse()).observe(root, { attributes: true, attributeFilter: ['class'] });
  new ResizeObserver(() => render()).observe(el);

  return {
    render,
    setBeat(b) {
      beat = b || { source: 'none' };
      syncPulse();
    },
    setPlayer(p) {
      player = p;
      syncPulse();
    },
  };
}
