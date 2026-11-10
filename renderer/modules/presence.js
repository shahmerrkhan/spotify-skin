// The minimal state: after `minimalMs` without mouse movement the glass panels
// fade out (art, title and clock stay). Any mouse movement brings them back at
// once. Keyboard input counts too, so Tab can always reach the controls.
// "Holds" (an open menu, keyboard focus inside the panels) keep them awake.

const IDLE_ENTRY_GRACE_MS = 3000;

export function createPresence({ minimalMs, onChange }) {
  let lastInput = Date.now();
  let calm = false;
  let timer = 0;
  const holds = new Set();

  const set = (v) => {
    if (calm === v) return;
    calm = v;
    onChange(calm);
  };

  function arm(ms = minimalMs) {
    clearTimeout(timer);
    timer = setTimeout(check, Math.max(50, ms));
  }

  function check() {
    const quiet = Date.now() - lastInput;
    if (holds.size) return arm();
    if (quiet >= minimalMs) set(true);
    else arm(minimalMs - quiet);
  }

  // Hot path (every mousemove): just a timestamp, unless we're waking up.
  function wake() {
    lastInput = Date.now();
    if (calm) {
      set(false);
      arm();
    }
  }

  for (const type of ['mousemove', 'pointerdown', 'wheel', 'keydown']) {
    window.addEventListener(type, wake, { passive: true, capture: true });
  }
  arm();

  return {
    get calm() { return calm; },
    hold(key, on) {
      if (on) {
        holds.add(key);
        set(false);
      } else if (holds.delete(key)) {
        arm();
      }
    },
    // Entering idle (paused, stopped, closed) fades the panels right away, unless
    // you just moved the mouse here (e.g. you clicked pause on the dock).
    enterIdle() {
      if (!holds.size && Date.now() - lastInput > IDLE_ENTRY_GRACE_MS) set(true);
    },
  };
}
