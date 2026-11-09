// Phase 1: just the Hide controls. State, components and data arrive in phase 2.

const hide = () => window.skin.hide();

document.getElementById('hide').addEventListener('click', hide);

window.addEventListener('keydown', (e) => {
  // Later inputs (search) call preventDefault() on Escape to clear themselves first.
  if (e.key === 'Escape' && !e.repeat && !e.defaultPrevented) hide();
});
