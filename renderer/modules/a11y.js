// Display options (the "Aa" pill): reduce motion, larger text, higher contrast,
// and three edge glow rows: level, width, reach (each low / medium / high style).
// Each glow row is a radiogroup (data-seg = the setting) mirrored onto <html> as a
// data attribute (glowWidth -> data-glow-width) for CSS and the glow painter.
// Saved to config.json through the main process. Reduce motion starts out
// following the system setting until you flip it yourself.

export function setupA11y({ root, button, menu, initial, save, onOpenChange }) {
  const state = {
    reducedMotion: null, largeText: false, highContrast: false,
    glow: 'medium', glowWidth: 'medium', glowReach: 'medium', ...initial,
  };
  const segs = [...menu.querySelectorAll('[data-seg]')].map((g) => ({
    key: g.dataset.seg,
    opts: [...g.querySelectorAll('[data-value]')],
  }));
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const switches = [...menu.querySelectorAll('[data-a11y]')];

  const effective = (key) => (key === 'reducedMotion' ? state.reducedMotion ?? mq.matches : Boolean(state[key]));

  function apply() {
    root.classList.toggle('reduce-motion', effective('reducedMotion'));
    root.classList.toggle('large', effective('largeText'));
    root.classList.toggle('contrast', effective('highContrast'));
    for (const sw of switches) sw.setAttribute('aria-checked', String(effective(sw.dataset.a11y)));
    for (const { key, opts } of segs) {
      root.dataset[key] = state[key];
      for (const o of opts) {
        const on = o.dataset.value === state[key];
        o.setAttribute('aria-checked', String(on));
        o.tabIndex = on ? 0 : -1; // one tab stop per row; arrows move inside it
      }
    }
  }

  function setSeg(seg, value, focus) {
    state[seg.key] = value;
    apply();
    save({ ...state });
    if (focus) seg.opts.find((o) => o.dataset.value === value)?.focus();
  }

  function setOpen(open) {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    onOpenChange(open);
    if (open) switches[0]?.focus();
  }

  button.addEventListener('click', () => setOpen(menu.hidden));
  for (const sw of switches) {
    sw.addEventListener('click', () => {
      const key = sw.dataset.a11y;
      state[key] = !effective(key);
      apply();
      save({ ...state });
    });
  }
  for (const seg of segs) {
    const { opts } = seg;
    for (const o of opts) {
      o.addEventListener('click', () => setSeg(seg, o.dataset.value, false));
      o.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        const i = opts.indexOf(o);
        setSeg(seg, opts[(i + step + opts.length) % opts.length].dataset.value, true);
      });
    }
  }
  // Escape closes the menu first (and doesn't hide the app); so does a click elsewhere.
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      button.focus();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) setOpen(false);
  });
  mq.addEventListener('change', apply);
  apply();

  return { reducedMotion: () => effective('reducedMotion') };
}
