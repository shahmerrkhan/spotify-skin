// Display options (the "Aa" pill): reduce motion, larger text, higher contrast.
// Saved to config.json through the main process. Reduce motion starts out
// following the system setting until you flip it yourself.

export function setupA11y({ root, button, menu, initial, save, onOpenChange }) {
  const state = { reducedMotion: null, largeText: false, highContrast: false, ...initial };
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const switches = [...menu.querySelectorAll('[data-a11y]')];

  const effective = (key) => (key === 'reducedMotion' ? state.reducedMotion ?? mq.matches : Boolean(state[key]));

  function apply() {
    root.classList.toggle('reduce-motion', effective('reducedMotion'));
    root.classList.toggle('large', effective('largeText'));
    root.classList.toggle('contrast', effective('highContrast'));
    for (const sw of switches) sw.setAttribute('aria-checked', String(effective(sw.dataset.a11y)));
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
