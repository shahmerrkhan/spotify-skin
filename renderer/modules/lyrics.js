// Synced lyrics, bottom right: a small rolling cylinder (drum) of 7 lines with the
// sung line lit, like a slot-machine reel seen from the front.
//
// Cost model: only the lines near the centre exist (7 visible + 1 fading in/out on
// each side), reused as the song moves on; nothing per frame. A timer fires at the
// next line's timestamp; the roll itself is a CSS transition on transform/opacity
// (compositor). Under Reduce motion it's a flat list that switches instantly.
//
// Interaction: wheel or arrow keys scroll by hand; 5 s after the last of that it
// rolls back to the sung line. Click (or Enter on) a line seeks there through the
// dock's own seek path, so the progress bar and its seek hold stay in step.
//
// Hidden entirely when the song has no synced lyrics, when Spotify isn't running,
// or when lyrics are switched off in the Aa menu (root class lyrics-off).

const HALF = 3;              // visible lines on each side of the centre (7 in all)
const POOL = HALF + 1;       // plus one each side, transparent, to roll in and out
const RADIUS = 105;          // drum radius in px (x1.2 with Larger text)
const GAP = 6;               // px between lines along the drum
const LEAD_MS = 120;         // light a line a touch early; Spotify's position lags a little
const SNAP_BACK_MS = 5000;
const WHEEL_STEP = 60;       // wheel delta per line (touchpads send many small deltas)

export function createLyrics({ root, el, drum, dock }) {
  let data = { trackId: '', lines: null };
  let player = null;
  let paused = false;
  let cur = -1;              // index of the sung line (-1: before the first)
  let view = 0;              // index at the centre
  let manual = false;        // scrolled by hand (view != follows cur)
  let snapTimer = 0;
  let lineTimer = 0;
  let wheelAcc = 0;
  let shownKey = '';
  const nodes = new Map();   // line index -> element (only those near the centre)

  const has = (c) => root.classList.contains(c);
  const lines = () => data.lines || [];
  const still = () => has('reduce-motion');

  function shouldShow() {
    return Boolean(data.lines?.length && player?.running && player.track && data.trackId === player.track.id
      && !has('lyrics-off'));
  }

  function indexAt(pos) {
    const ls = lines();
    let lo = 0;
    let hi = ls.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ls[mid].t <= pos + LEAD_MS) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  // Elements

  function makeLine(i) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lyrics__line cav';
    b.setAttribute('role', 'listitem');
    b.tabIndex = -1;
    const text = lines()[i].text;
    b.textContent = text || '♪';
    if (!text) b.classList.add('is-gap');
    b.dataset.i = String(i);
    return b;
  }

  function clearLines() {
    for (const n of nodes.values()) n.remove();
    nodes.clear();
  }

  // Lay out the lines around the centre (heights vary: long lines wrap).
  function render() {
    const ls = lines();
    if (!ls.length || el.hidden) return;
    const center = Math.min(Math.max(manual ? view : Math.max(cur, 0), 0), ls.length - 1);
    view = center;
    const focusedInside = drum.contains(document.activeElement);
    const lo = Math.max(0, center - POOL);
    const hi = Math.min(ls.length - 1, center + POOL);
    for (const [i, n] of nodes) {
      if (i < lo || i > hi) {
        n.remove();
        nodes.delete(i);
      }
    }
    const fresh = [];
    for (let i = lo; i <= hi; i++) {
      if (!nodes.has(i)) {
        const n = makeLine(i);
        nodes.set(i, n);
        drum.append(n);
        fresh.push(n);
      }
      const n = nodes.get(i);
      const on = i === cur;
      n.classList.toggle('is-current', on);
      if (on) n.setAttribute('aria-current', 'true');
      else n.removeAttribute('aria-current');
      n.tabIndex = i === center ? 0 : -1; // one Tab stop: the centre line
    }
    // Distance of each line's middle from the drum's middle, along the surface.
    const h = new Map();
    for (let i = lo; i <= hi; i++) h.set(i, nodes.get(i).offsetHeight);
    const s = new Map([[center, 0]]);
    for (let i = center + 1; i <= hi; i++) s.set(i, s.get(i - 1) + (h.get(i - 1) + h.get(i)) / 2 + GAP);
    for (let i = center - 1; i >= lo; i--) s.set(i, s.get(i + 1) - (h.get(i + 1) + h.get(i)) / 2 - GAP);
    const R = RADIUS * (has('large') ? 1.2 : 1);
    const flat = still();
    const place = (i) => {
      const n = nodes.get(i);
      const d = s.get(i);
      const far = Math.abs(i - center) > HALF;
      n.style.transform = flat
        ? `translateY(calc(-50% + ${d.toFixed(1)}px))`
        : `translateY(-50%) translateZ(${-R}px) rotateX(${(-d / R).toFixed(4)}rad) translateZ(${R}px)`;
      n.style.opacity = far ? '0' : String(flat ? 1 - Math.abs(i - center) * 0.12 : Math.max(0, 1 - (Math.abs(d) / (R * 1.45)) ** 2));
      n.inert = far;
    };
    // New lines start transparent where they belong, then fade/roll in with the rest.
    for (const n of fresh) {
      n.style.transition = 'none';
      place(Number(n.dataset.i));
      n.style.opacity = '0';
    }
    if (fresh.length) void drum.offsetHeight; // commit the start state
    for (const n of fresh) n.style.transition = '';
    for (let i = lo; i <= hi; i++) place(i);
    if (focusedInside && !drum.contains(document.activeElement)) nodes.get(center)?.focus({ preventScroll: true });
  }

  // Timing

  function schedule() {
    clearTimeout(lineTimer);
    lineTimer = 0;
    if (el.hidden || paused || !dock.isPlaying()) return;
    const next = lines()[cur + 1];
    if (!next) return;
    const delay = (next.t - LEAD_MS - dock.positionNow()) / (player?.rate || 1);
    lineTimer = setTimeout(sync, Math.max(30, delay));
  }

  function sync() {
    const show = shouldShow();
    if (el.hidden === show) {
      el.hidden = !show;
      root.classList.toggle('has-lyrics', show);
      if (!show) {
        clearLines();
        clearTimeout(lineTimer);
        return;
      }
    }
    if (!show) return;
    const i = indexAt(dock.positionNow());
    const key = `${data.trackId}|${still()}|${has('large')}`;
    if (i !== cur || key !== shownKey || !nodes.size) {
      cur = i;
      shownKey = key;
      render();
    }
    schedule();
  }

  // Scrolling by hand

  function scrollBy(step, focus) {
    if (!lines().length) return;
    manual = true;
    view = Math.min(Math.max(view + step, 0), lines().length - 1);
    render();
    if (focus) nodes.get(view)?.focus({ preventScroll: true });
    clearTimeout(snapTimer);
    snapTimer = setTimeout(snapBack, SNAP_BACK_MS);
  }

  function snapBack() {
    clearTimeout(snapTimer);
    if (!manual) return;
    manual = false;
    render();
  }

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    wheelAcc += e.deltaY;
    while (Math.abs(wheelAcc) >= WHEEL_STEP) {
      const step = Math.sign(wheelAcc);
      wheelAcc -= step * WHEEL_STEP;
      scrollBy(step, false);
    }
  }, { passive: false });

  drum.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: HALF, PageUp: -HALF }[e.key];
    if (!step) return;
    e.preventDefault();
    scrollBy(step, true);
  });

  drum.addEventListener('click', (e) => {
    const n = e.target.closest('.lyrics__line');
    if (!n || n.inert) return;
    const line = lines()[Number(n.dataset.i)];
    if (!line) return;
    dock.seek(line.t);
    manual = false;
    clearTimeout(snapTimer);
    cur = -2; // force a re-layout at the new spot
    sync();
  });

  // Settings that change the layout (Aa menu), or hide it.
  new MutationObserver(() => sync()).observe(root, { attributes: true, attributeFilter: ['class'] });

  return {
    setLyrics(l) {
      data = l?.lines?.length ? l : { trackId: l?.trackId || '', lines: null };
      clearLines();
      cur = -1;
      view = 0;
      manual = false;
      clearTimeout(snapTimer);
      sync();
    },
    // Call after dock.update(): position comes from the dock (incl. its seek hold).
    setPlayer(p) {
      player = p;
      sync();
    },
    setPaused(v) {
      paused = v;
      sync();
    },
  };
}
