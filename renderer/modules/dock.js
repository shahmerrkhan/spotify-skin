// Control bar + bottom-left title. The progress bar runs on the compositor (Web
// Animations from the current spot to the end of the track), so a playing song
// costs no per-frame JavaScript; the time labels tick once a second.

const SHORT_TITLE = 20; // Homemade Apple up to this many characters, Caveat 700 beyond
const SEEK_STEP_MS = 5000;

export function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Title font rule: short titles in Homemade Apple, long ones in Caveat 700.
// The text goes through the marquee, which scrolls it only if it doesn't fit.
export function setTitle(el, title, mq) {
  const short = [...title].length <= SHORT_TITLE;
  el.classList.toggle('app', short);
  el.classList.toggle('cav', !short);
  mq.set(el, title);
}

// Repeat cycles off -> all -> one, using Spotify's own names for them.
const REPEAT_NEXT = { None: 'Playlist', Playlist: 'Track', Track: 'None' };
const REPEAT_LABEL = { None: 'off', Playlist: 'all', Track: 'one' };
// After a click the button shows what you picked until Spotify reports that value
// (or this long passes), so an update that still has the old value can't flip it
// back, and a quick next click carries on from your pick.
const PICK_HOLD_MS = 3000;

export function createDock(els, skin, mq) {
  let player = null;
  let paused = false;     // animations paused (locked / asleep / covered)
  let anims = [];
  let ticker = 0;
  let railWidth = els.rail.clientWidth;

  const playing = () => Boolean(player?.running && player.status === 'Playing' && player.track);
  const lengthMs = () => player?.track?.lengthMs || 0;
  const positionNow = () => {
    if (!player) return 0;
    const p = player.status === 'Playing' ? player.positionMs + (Date.now() - player.positionAt) * (player.rate || 1) : player.positionMs;
    return Math.min(Math.max(0, p), lengthMs() || Infinity);
  };

  // Progress

  function stopAnims() {
    for (const a of anims) a.cancel();
    anims = [];
  }

  function drawStatic(frac) {
    els.fill.style.transform = `scaleX(${frac})`;
    els.knob.style.transform = `translateX(${frac * railWidth}px)`;
  }

  function syncProgress() {
    stopAnims();
    const len = lengthMs();
    const pos = positionNow();
    const frac = len ? pos / len : 0;
    drawStatic(frac);
    if (playing() && !paused && len > 0) {
      const duration = Math.max(0, (len - pos) / (player.rate || 1));
      const opts = { duration, easing: 'linear', fill: 'forwards' };
      anims = [
        els.fill.animate([{ transform: `scaleX(${frac})` }, { transform: 'scaleX(1)' }], opts),
        els.knob.animate([{ transform: `translateX(${frac * railWidth}px)` }, { transform: `translateX(${railWidth}px)` }], opts),
      ];
    }
    tick();
    clearInterval(ticker);
    ticker = playing() && !paused ? setInterval(tick, 1000) : 0;
  }

  function tick() {
    const len = lengthMs();
    const pos = positionNow();
    els.timePos.textContent = fmt(pos);
    els.timeLeft.textContent = len ? `−${fmt(len - pos)}` : '0:00';
    els.rail.setAttribute('aria-valuemax', String(Math.round(len / 1000)));
    els.rail.setAttribute('aria-valuenow', String(Math.round(pos / 1000)));
    els.rail.setAttribute('aria-valuetext', `${fmt(pos)} of ${fmt(len)}`);
  }

  function seekTo(ms) {
    const len = lengthMs();
    if (!player?.running || !len) return;
    const target = Math.min(Math.max(0, ms), len);
    // Show it right away; Spotify's answer re-syncs on the next update.
    player = { ...player, positionMs: target, positionAt: Date.now() };
    syncProgress();
    skin.seek(target);
  }

  els.rail.addEventListener('pointerdown', (e) => {
    const r = els.rail.getBoundingClientRect();
    seekTo(((e.clientX - r.left) / r.width) * lengthMs());
  });
  els.rail.addEventListener('keydown', (e) => {
    const step = { ArrowRight: SEEK_STEP_MS, ArrowUp: SEEK_STEP_MS, ArrowLeft: -SEEK_STEP_MS, ArrowDown: -SEEK_STEP_MS }[e.key];
    if (step) seekTo(positionNow() + step);
    else if (e.key === 'Home') seekTo(0);
    else return;
    e.preventDefault();
  });
  new ResizeObserver(() => {
    railWidth = els.rail.clientWidth;
    syncProgress();
  }).observe(els.rail);

  // Buttons

  els.prev.addEventListener('click', () => skin.control('Previous'));
  els.next.addEventListener('click', () => skin.control('Next'));
  els.play.addEventListener('click', () => skin.control('PlayPause'));
  // Your latest pick per setting: { value, until } or null.
  const picks = { shuffle: null, loop: null };
  const pickTimers = {};

  function pick(key, value) {
    picks[key] = { value, until: Date.now() + PICK_HOLD_MS };
    clearTimeout(pickTimers[key]);
    pickTimers[key] = setTimeout(() => { picks[key] = null; drawToggles(); }, PICK_HOLD_MS);
  }

  // What the button should show: your pick while it's fresh, else Spotify's value.
  // The pick ends early once Spotify agrees, or once the setting greys out.
  function shown(key, ok) {
    const p = picks[key];
    if (p && (!ok || player[key] === p.value || Date.now() >= p.until)) {
      picks[key] = null;
      clearTimeout(pickTimers[key]);
    }
    return picks[key] ? picks[key].value : player[key];
  }

  // Greyed but clickable when Spotify didn't apply the last change (a click tries
  // again); greyed and inert only when Spotify doesn't offer the setting at all.
  const clickable = (missing) => Boolean(player?.running) && !player[missing];

  els.shuffle.addEventListener('click', () => {
    if (!clickable('shuffleMissing')) return;
    const on = !shown('shuffle', player.shuffleOk);
    pick('shuffle', on);
    player = { ...player, shuffleOk: true };
    drawToggles();
    skin.setShuffle(on);
  });
  els.repeat.addEventListener('click', () => {
    if (!clickable('loopMissing')) return;
    const next = REPEAT_NEXT[shown('loop', player.loopOk)] || 'None';
    pick('loop', next);
    player = { ...player, loopOk: true };
    drawToggles();
    skin.setRepeat(next);
  });

  function drawToggle(btn, { ok, missing, label, value, onLabel }) {
    const running = Boolean(player?.running);
    const grey = running && !player[ok];
    btn.disabled = !running;
    btn.classList.toggle('is-off', grey);
    btn.classList.toggle('is-retry', grey && !player[missing]);
    btn.setAttribute('aria-pressed', String(running && value !== onLabel.offValue));
    btn.setAttribute('aria-label', `${label}: ${onLabel.text}`);
    btn.title = !grey ? `${label}: ${onLabel.text}`
      : player[missing] ? `Spotify doesn't offer ${label.toLowerCase()} here`
        : "Spotify didn't accept this; click to try again";
  }

  function drawToggles() {
    const running = Boolean(player?.running);
    const shuffle = running ? Boolean(shown('shuffle', player.shuffleOk)) : false;
    drawToggle(els.shuffle, { ok: 'shuffleOk', missing: 'shuffleMissing', label: 'Shuffle', value: shuffle, onLabel: { offValue: false, text: shuffle ? 'on' : 'off' } });
    const loop = running ? shown('loop', player.loopOk) : 'None';
    drawToggle(els.repeat, { ok: 'loopOk', missing: 'loopMissing', label: 'Repeat', value: loop, onLabel: { offValue: 'None', text: REPEAT_LABEL[loop] || 'off' } });
    els.repeatIcon.setAttribute('href', `/assets/icons/sprite.svg#${loop === 'Track' ? 'i-repeat-one' : 'i-repeat'}`);
  }

  function update(p) {
    player = p;
    const running = Boolean(p?.running);
    const t = p?.track;
    const isPlaying = playing();

    for (const b of [els.prev, els.play, els.next]) b.disabled = !running;
    drawToggles();
    els.play.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    els.playIcon.setAttribute('href', `/assets/icons/sprite.svg#${isPlaying ? 'i-pause' : 'i-play'}`);
    els.rail.setAttribute('aria-disabled', String(!running || !t));

    // Titles in both places: the dock and the bottom left.
    const title = t?.title || (running ? 'Nothing playing' : '');
    const artist = t ? t.artist || t.album : '';
    setTitle(els.dockTitle, title, mq);
    mq.set(els.dockArtist, artist);
    const showNow = Boolean(running && t && p.status !== 'Stopped');
    els.now.hidden = !showNow;
    if (showNow) {
      setTitle(els.nowTitle, t.title, mq);
      mq.set(els.nowArtist, artist);
    }
    syncProgress();
  }

  return {
    update,
    setPaused(v) {
      paused = v;
      syncProgress();
    },
  };
}
