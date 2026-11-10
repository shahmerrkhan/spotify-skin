'use strict';
// Decides when the UI should pause its animations: the screen is locked, the
// screensaver is on, the machine is asleep, or other windows fully cover ours.
//
// "Fully covered" on X11: every managed window stacked above ours (on the current
// workspace, not minimised, frame included) is painted onto a coarse 40px grid of
// our bounds; covered means no cell is left showing. Checks run when the window
// stack, active window or workspace changes (xprop -spy, no polling cost while
// nothing happens) plus a slow safety poll for resizes, which change none of those.

// Also emits 'active' (window id, 0 for none) when the focused window changes.

const { EventEmitter } = require('node:events');
const { execFile, spawn } = require('node:child_process');

const CELL = 40;
const SAFETY_POLL_MS = 5000;
const DEBOUNCE_MS = 250;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 2000 }, (err, out) => resolve(err ? '' : out));
  });
}

const hex = (s) => (s ? parseInt(s, 16) : NaN);

// Desktop-type windows (xfdesktop, the skin) count as "no app window".
async function isDesktopWindow(id) {
  const out = await run('xprop', ['-id', `0x${id.toString(16)}`, '_NET_WM_WINDOW_TYPE']);
  return /_NET_WM_WINDOW_TYPE_DESKTOP/.test(out);
}

async function windowInfo(id) {
  const idArg = `0x${id.toString(16)}`;
  const [props, geo] = await Promise.all([
    run('xprop', ['-id', idArg, '_NET_WM_STATE', '_NET_WM_DESKTOP', '_NET_WM_WINDOW_TYPE', '_NET_FRAME_EXTENTS']),
    run('xwininfo', ['-id', idArg]),
  ]);
  if (!props || !geo) return null;
  const num = (re) => Number(geo.match(re)?.[1]);
  const frame = (props.match(/_NET_FRAME_EXTENTS\(CARDINAL\) = (\d+), (\d+), (\d+), (\d+)/) || []).slice(1).map(Number);
  const [fl = 0, fr = 0, ft = 0, fb = 0] = frame;
  const desk = props.match(/_NET_WM_DESKTOP\(CARDINAL\) = (\d+)/);
  return {
    hidden: /_NET_WM_STATE_HIDDEN/.test(props),
    desktopType: /_NET_WM_WINDOW_TYPE_DESKTOP/.test(props),
    desktop: desk ? Number(desk[1]) : -1,
    viewable: /Map State: IsViewable/.test(geo),
    x: num(/Absolute upper-left X:\s+(-?\d+)/) - fl,
    y: num(/Absolute upper-left Y:\s+(-?\d+)/) - ft,
    w: num(/Width:\s+(\d+)/) + fl + fr,
    h: num(/Height:\s+(\d+)/) + ft + fb,
  };
}

class Visibility extends EventEmitter {
  constructor({ systemBus, sessionBus, getXid, getBounds }) {
    super();
    this.systemBus = systemBus;
    this.sessionBus = sessionBus;
    this.getXid = getXid;
    this.getBounds = getBounds;
    this.flags = { covered: false, locked: false, saver: false, asleep: false };
    this.paused = false;
    this.running = false;
    this.cleanups = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._startStackWatch();
    this._watchLock().catch((err) => console.warn(`[visibility] lock watch unavailable: ${err.message}`));
    this._watchSaver().catch((err) => console.warn(`[visibility] screensaver watch unavailable: ${err.message}`));
    this.check();
  }

  stop() {
    this.running = false;
    clearTimeout(this.debounce);
    clearInterval(this.poll);
    this.spy?.kill();
    this.spy = null;
    for (const fn of this.cleanups.splice(0)) fn();
    this.flags = { covered: false, locked: false, saver: false, asleep: false };
    this.paused = false;
    this.active = undefined;
  }

  set(flag, value) {
    if (this.flags[flag] === value) return;
    this.flags[flag] = value;
    const paused = Object.values(this.flags).some(Boolean);
    if (paused !== this.paused) {
      this.paused = paused;
      this.emit('change', paused, { ...this.flags });
    }
  }

  // Stack watching

  _startStackWatch() {
    const spy = spawn('xprop', ['-root', '-spy', '_NET_CLIENT_LIST_STACKING', '_NET_ACTIVE_WINDOW', '_NET_CURRENT_DESKTOP'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    spy.stdout.on('data', () => this.schedule());
    spy.on('error', (err) => console.warn(`[visibility] xprop unavailable: ${err.message}`));
    this.spy = spy;
    this.poll = setInterval(() => this.check(), SAFETY_POLL_MS);
  }

  schedule() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.check(), DEBOUNCE_MS);
  }

  async check() {
    if (!this.running || this.checking) return;
    this.checking = true;
    try {
      const covered = await this._isCovered();
      if (this.running && covered !== null) this.set('covered', covered);
    } finally {
      this.checking = false;
    }
  }

  async _isCovered() {
    const own = this.getXid();
    const b = this.getBounds();
    if (!own || !b) return null;
    const root = await run('xprop', ['-root', '_NET_CLIENT_LIST_STACKING', '_NET_CURRENT_DESKTOP', '_NET_ACTIVE_WINDOW']);
    const active = hex(root.match(/_NET_ACTIVE_WINDOW\(WINDOW\): window id # (0x[0-9a-f]+)/)?.[1]) || 0;
    if (root && active !== this.active) {
      this.active = active;
      this.emit('active', active);
    }
    const ids = (root.match(/_NET_CLIENT_LIST_STACKING\(WINDOW\): window id # (.*)/)?.[1] || '')
      .split(',').map((s) => hex(s.trim())).filter((n) => n > 0);
    const current = Number(root.match(/_NET_CURRENT_DESKTOP\(CARDINAL\) = (\d+)/)?.[1] ?? 0);
    const ownIdx = ids.indexOf(own);
    const above = ownIdx >= 0 ? ids.slice(ownIdx + 1) : ids.filter((id) => id !== own);
    if (!above.length) return false;

    const infos = await Promise.all(above.map(windowInfo));
    const cols = Math.ceil(b.width / CELL);
    const rows = Math.ceil(b.height / CELL);
    const grid = new Uint8Array(cols * rows);
    for (const w of infos) {
      if (!w || w.hidden || w.desktopType || !w.viewable) continue;
      if (w.desktop !== current && w.desktop !== 0xffffffff && w.desktop !== -1) continue;
      // A cell counts as covered when the window contains the cell's centre.
      const c0 = Math.max(0, Math.ceil((w.x - b.x) / CELL - 0.5));
      const c1 = Math.min(cols - 1, Math.floor((w.x + w.w - b.x) / CELL - 0.5));
      const r0 = Math.max(0, Math.ceil((w.y - b.y) / CELL - 0.5));
      const r1 = Math.min(rows - 1, Math.floor((w.y + w.h - b.y) / CELL - 0.5));
      for (let r = r0; r <= r1; r++) grid.fill(1, r * cols + c0, r * cols + c1 + 1);
    }
    return grid.every((v) => v === 1);
  }

  // Lock screen (logind LockedHint; light-locker sets it) and screensaver

  async _watchLock() {
    const obj = await this.systemBus.getProxyObject('org.freedesktop.login1', '/org/freedesktop/login1/session/auto');
    const props = obj.getInterface('org.freedesktop.DBus.Properties');
    const onChange = (iface, changed) => {
      if (iface === 'org.freedesktop.login1.Session' && changed.LockedHint) this.set('locked', Boolean(changed.LockedHint.value));
    };
    props.on('PropertiesChanged', onChange);
    this.cleanups.push(() => props.removeListener('PropertiesChanged', onChange));
    const v = await props.Get('org.freedesktop.login1.Session', 'LockedHint');
    if (this.running) this.set('locked', Boolean(v.value));
  }

  async _watchSaver() {
    const obj = await this.sessionBus.getProxyObject('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver');
    const saver = obj.getInterface('org.freedesktop.ScreenSaver');
    const onActive = (active) => this.set('saver', Boolean(active));
    saver.on('ActiveChanged', onActive);
    this.cleanups.push(() => saver.removeListener('ActiveChanged', onActive));
    try {
      const active = await saver.GetActive();
      if (this.running) this.set('saver', Boolean(active));
    } catch {
      // Some implementations don't answer GetActive; the signal still works.
    }
  }
}

module.exports = { Visibility, isDesktopWindow };
