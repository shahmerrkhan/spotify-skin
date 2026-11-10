// Display options (the "Aa" pill): reduce motion, larger text, higher contrast,
// and the edge glow level (low / medium / high).
// Saved to config.json through the main process. Reduce motion starts out
// following the system setting until you flip it yourself.

export function setupA11y({ root, button, menu, initial, save, onOpenChange }) {
  const state = { reducedMotion: null, largeText: false, highContrast: false, glow: 'medium', ...initial };
  const glowOpts = [...menu.querySelectorAll('[data-glow]')];
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const switches = [...menu.querySelectorAll('[data-a11y]')];

  const effective = (key) => (key === 'reducedMotion' ? state.reducedMotion ?? mq.matches : Boolean(state[key]));

  function apply() {
    root.classList.toggle('reduce-motion', effective('reducedMotion'));
    root.classList.toggle('large', effective('largeText'));
    root.classList.toggle('contrast', effective('highContrast'));
    for (const sw of switches) sw.setAttribute('aria-checked', String(effective(sw.dataset.a11y)));
    root.dataset.glow = state.glow;
    for (const o of glowOpts) {
      const on = o.dataset.glow === state.glow;
      o.setAttribute('aria-checked', String(on));
      o.tabIndex = on ? 0 : -1; // one tab stop for the group; arrows move inside it
    }
  }

  function setGlow(level, focus) {
    state.glow = level;
    apply();
    save({ ...state });
    if (focus) glowOpts.find((o) => o.dataset.glow === level)?.focus();
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
  for (const o of glowOpts) {
    o.addEventListener('click', () => setGlow(o.dataset.glow, false));
    o.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const i = glowOpts.indexOf(o);
      setGlow(glowOpts[(i + step + glowOpts.length) % glowOpts.length].dataset.glow, true);
    });
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
