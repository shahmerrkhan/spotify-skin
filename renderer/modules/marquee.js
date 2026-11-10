// Long titles and artists: when the text is wider than its box it scrolls slowly
// to the end and back, resting ~2 s at each end. Text that fits never moves.
// The movement is a Web Animation on a transform, so it runs on the compositor
// with no per-frame JavaScript. With Reduce motion it doesn't scroll at all: the
// text wraps onto a second line instead.

const SPEED_PX_S = 34;
const REST_MS = 2000;

export function createMarquee({ root, isAsleep = () => false }) {
  const items = new Map(); // host element -> { inner, anim, text, dist }
  let paused = false;

  const reduced = () => root.classList.contains('reduce-motion');

  function inner(host) {
    let it = items.get(host);
    if (it) return it;
    const span = document.createElement('span');
    span.className = 'mq__in';
    host.replaceChildren(span);
    host.classList.add('mq');
    it = { inner: span, anim: null, text: null, dist: -1 };
    items.set(host, it);
    ro.observe(host);
    ro.observe(span); // font loads and Larger text change the text's width
    return it;
  }

  function stop(it) {
    it.anim?.cancel();
    it.anim = null;
  }

  function measure(host) {
    const it = items.get(host);
    if (!it) return;
    const wrap = reduced();
    host.classList.toggle('mq--wrap', wrap);
    const dist = wrap ? 0 : Math.max(0, Math.ceil(it.inner.scrollWidth - host.clientWidth));
    const moving = dist > 2;
    host.classList.toggle('mq--on', moving);
    if (dist === it.dist && (it.anim !== null) === moving) return syncPlay(host, it);
    it.dist = dist;
    stop(it);
    if (!moving) return;
    const travel = (dist / SPEED_PX_S) * 1000;
    const total = 2 * (travel + REST_MS);
    const a = REST_MS / total;
    const b = (REST_MS + travel) / total;
    const end = `translateX(${-dist}px)`;
    it.anim = it.inner.animate([
      { transform: 'translateX(0)', offset: 0 },
      { transform: 'translateX(0)', offset: a, easing: 'ease-in-out' },
      { transform: end, offset: b },
      { transform: end, offset: b + a, easing: 'ease-in-out' },
      { transform: 'translateX(0)', offset: 1 },
    ], { duration: total, iterations: Infinity });
    syncPlay(host, it);
  }

  function syncPlay(host, it) {
    if (!it.anim) return;
    if (paused || isAsleep(host)) it.anim.pause();
    else it.anim.play();
  }

  const ro = new ResizeObserver((entries) => {
    const hosts = new Set(entries.map((e) => (e.target.classList.contains('mq__in') ? e.target.parentElement : e.target)));
    for (const h of hosts) measure(h);
  });
  new MutationObserver(() => {
    for (const h of items.keys()) measure(h);
  }).observe(root, { attributes: true, attributeFilter: ['class'] });

  return {
    set(host, text) {
      const it = inner(host);
      if (it.text === text) return;
      it.text = text;
      it.inner.textContent = text;
      it.dist = -1;
      measure(host);
    },
    // Locked / asleep / covered: everything holds still.
    setPaused(v) {
      paused = v;
      for (const [h, it] of items) syncPlay(h, it);
    },
    // Re-check which hosts are asleep (e.g. the dock fades out in the minimal state).
    refresh() {
      for (const [h, it] of items) syncPlay(h, it);
    },
  };
}
