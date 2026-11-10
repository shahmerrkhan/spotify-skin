// Wires the UI to the main process: Spotify state, cover art, history, pause signal.

import { extract, toCss } from './modules/palette.js';
import { renderBackdrop, Backdrop } from './modules/background.js';
import { startClock } from './modules/clock.js';
import { createDock } from './modules/dock.js';
import { createQueue } from './modules/queue.js';
import { drawGlow } from './modules/glow.js';
import { createPresence } from './modules/presence.js';
import { setupA11y } from './modules/a11y.js';
import { createMarquee } from './modules/marquee.js';

const BRIGHT_L = 0.7; // OKLab lightness behind the clock above which it turns dark-tinted

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const skin = window.skin;

const init = (await skin.init()) || {};

let player = init.player || null;
let art = init.art || { trackId: '', name: null };
let history = init.history || [];
let light = null;          // brightness behind the clock for the current art
let wasIdle = null;

// Layout: keep clear of the XFCE panel in the desktop layer.
for (const [k, v] of Object.entries(init.insets || {})) root.style.setProperty(`--safe-${k}`, `${v}px`);

// Minimal state after N seconds without the mouse
const presence = createPresence({
  minimalMs: (init.minimalAfterSec || 30) * 1000,
  onChange: (calm) => root.classList.toggle('is-calm', calm),
});
// Display options
setupA11y({
  root,
  button: $('a11y-btn'),
  menu: $('a11y-menu'),
  initial: init.a11y,
  save: (a) => skin.saveA11y(a),
  onOpenChange: (open) => presence.hold('menu', open),
});

const chrome = $('chrome');
// Scrolling long titles; the dock's copies rest while the panels are faded out.
const mq = createMarquee({ root, isAsleep: (el) => root.classList.contains('is-calm') && chrome.contains(el) });
// Only keyboard focus holds the panels (a mouse click focuses buttons too).
chrome.addEventListener('focusin', (e) => presence.hold('focus', e.target.matches(':focus-visible')));
chrome.addEventListener('focusout', (e) => {
  if (!chrome.contains(e.relatedTarget)) presence.hold('focus', false);
});

const clock = startClock({ root: $('clock'), dateEl: $('clock-date'), timeEl: $('clock-time'), h24: init.clock24h !== false });
drawGlow([...document.querySelectorAll('.glow__wave')]);
const backdrop = new Backdrop($('bg-0'), $('bg-1'));
const queue = createQueue({ list: $('queue-list'), empty: $('queue-empty') });
const dock = createDock({
  prev: $('btn-prev'), play: $('btn-play'), next: $('btn-next'), shuffle: $('btn-shuffle'), playIcon: $('play-icon'),
  repeat: $('btn-repeat'), repeatIcon: $('repeat-icon'),
  rail: $('rail'), fill: $('fill'), knob: $('knob'), timePos: $('time-pos'), timeLeft: $('time-left'),
  dockTitle: $('dock-title'), dockArtist: $('dock-artist'),
  now: $('now'), nowTitle: $('now-title'), nowArtist: $('now-artist'),
}, skin, mq);

function setPalette(p) {
  for (const [k, v] of Object.entries(toCss(p))) root.style.setProperty(k, v);
}

function applyClockTint() {
  const idle = root.classList.contains('is-idle');
  const dark = Boolean(light && (idle ? light.center : light.top) > BRIGHT_L);
  root.classList.toggle('clock-dark', dark);
  root.style.setProperty('--clock-now', dark ? 'var(--clock-dark)' : 'var(--clock)');
}

function renderQueue() {
  const t = player?.running ? player.track : null;
  queue.render({ current: t, currentArt: t && art.trackId === t.id ? art.name : null, history });
}

function update() {
  const running = Boolean(player?.running);
  const idle = !running || player.status !== 'Playing' || !player.track;
  root.classList.toggle('no-spotify', !running);
  root.classList.toggle('is-playing', !idle);
  root.classList.toggle('is-idle', idle);
  $('notice').hidden = running;
  if (idle && wasIdle === false) presence.enterIdle();
  wasIdle = idle;
  dock.update(player);
  renderQueue();
  applyClockTint();
  if (!running && art.name) {
    // Spotify quit: drop the cover (main has already put your wallpaper back).
    art = { trackId: '', name: null };
    loadArt();
  }
}

// Cover art → palette, background, wallpaper, record label

let artGen = 0;
async function loadArt() {
  const gen = ++artGen;
  const { trackId, name } = art;
  renderQueue();
  if (!name) {
    backdrop.clear();
    setPalette(null);
    light = null;
    applyClockTint();
    $('record-label').removeAttribute('src');
    return;
  }
  // Decode into an ImageBitmap we free ourselves; an <img> would stay decoded in the cache.
  let bmp;
  try {
    const res = await fetch(`app://skin/art/${name}.jpg`);
    bmp = await createImageBitmap(await res.blob());
  } catch {
    return;
  }
  if (gen !== artGen) return bmp.close();
  setPalette(extract(bmp));
  $('record-label').src = `app://skin/art/${name}-t.jpg`;
  const { blob, bitmap, light: l } = await renderBackdrop(bmp, window.innerWidth, window.innerHeight);
  bmp.close();
  if (gen !== artGen) return bitmap.close();
  light = l;
  applyClockTint();
  backdrop.show(bitmap);
  skin.setWallpaper(trackId, new Uint8Array(await blob.arrayBuffer()));
}

skin.onPlayer((p) => {
  player = p;
  update();
});
skin.onArt((a) => {
  art = a;
  loadArt();
});
skin.onHistory((h) => {
  history = h;
  renderQueue();
});
skin.onPaused((paused) => {
  root.classList.toggle('anim-paused', paused);
  dock.setPaused(paused);
  mq.setPaused(paused);
  if (!paused) clock.refresh();
});

// Hide: the pill, or Esc (unless something else used the Escape first)
const hide = () => skin.hide();
$('hide').addEventListener('click', hide);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.repeat && !e.defaultPrevented) hide();
});

// Space = play/pause. The skin gets keyboard focus by itself whenever no app window
// is focused (main process), so this works on the bare desktop without a click.
// A control you reached with Tab keeps its own Space (press the focused button).
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
  const t = e.target;
  if (t instanceof Element && (t.matches('input, textarea, [contenteditable]') || t.matches(':focus-visible'))) return;
  e.preventDefault();
  // A button focused by an earlier mouse click would otherwise "click" on key-up.
  if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
  if (!e.repeat && player?.running) skin.control('PlayPause');
});
$('open-spotify').addEventListener('click', () => skin.openSpotify());

root.classList.toggle('anim-paused', Boolean(init.paused));
dock.setPaused(Boolean(init.paused));
mq.setPaused(Boolean(init.paused));
update();
loadArt();
