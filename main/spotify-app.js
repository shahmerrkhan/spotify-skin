'use strict';
// Starts Spotify for you and keeps its window out of the way.
//
// Spotify has no "start minimised" on Linux (its --minimized flag is Windows-only)
// and no tray icon. So when the skin starts Spotify, it watches the window list and
// withdraws Spotify's window the moment the window manager picks it up: it's then
// not on screen, not in the taskbar and not in Alt+Tab, while Spotify keeps running
// and the skin controls it over MPRIS. Spotify may flash for a split second first.
//
// A withdrawn window doesn't come back if you launch Spotify again from the menu,
// so the tray menu has "Show Spotify", and whenever the skin is hidden or quits,
// Spotify goes back to the taskbar, minimised.
//
// Only windows the skin started are hidden, and only until you show them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { CACHE_DIR, writeJsonAtomic } = require('./config');

const HELPER = path.join(__dirname, 'xwin.py');
const STATE_FILE = path.join(CACHE_DIR, 'spotify-window.json');
const WAIT_MS = 60_000;   // how long to look for the window after starting Spotify
const GRACE_MS = 15_000;  // keep it hidden if Spotify maps it again right after starting

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 3000 }, (err, out) => resolve(err ? '' : out));
  });
}

const toHex = (id) => `0x${id.toString(16)}`;

function clientList(out) {
  return (out.match(/_NET_CLIENT_LIST\(WINDOW\): window id # (.*)/)?.[1] || '')
    .split(',').map((s) => parseInt(s.trim(), 16)).filter((n) => n > 0);
}

// WM_CLASS is ("spotify", "Spotify") for the real app. The dev mock's stand-in is
// ("spotify", "Xmessage"), and in dev only that one matches, never the real Spotify.
async function wmClass(id) {
  const out = await run('xprop', ['-id', toHex(id), 'WM_CLASS']);
  const m = out.match(/WM_CLASS\(STRING\) = "([^"]*)", "([^"]*)"/);
  return m ? { instance: m[1], cls: m[2] } : null;
}
const REAL = (c) => c.cls === 'Spotify';
const MOCK = (c) => c.instance === 'spotify' && c.cls === 'Xmessage';

async function clientIds() {
  return clientList(await run('xprop', ['-root', '_NET_CLIENT_LIST']));
}

async function windowState(id) {
  const out = await run('xprop', ['-id', toHex(id), 'WM_STATE']);
  if (!out) return 'gone';
  return out.match(/window state: (\w+)/)?.[1]?.toLowerCase() || 'withdrawn';
}

// Is a Spotify process running at all (it can be up before it shows on D-Bus)?
function processRunning() {
  let dirs;
  try {
    dirs = fs.readdirSync('/proc');
  } catch {
    return false;
  }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim() === 'spotify') return true;
    } catch {
      // process ended while we looked
    }
  }
  return false;
}

function spotifyCommand() {
  // Prefer the Flatpak if it's installed (this machine has it), else a native install.
  const flatpakDirs = ['/var/lib/flatpak/app/com.spotify.Client', path.join(os.homedir(), '.local/share/flatpak/app/com.spotify.Client')];
  if (flatpakDirs.some((d) => fs.existsSync(d))) return ['flatpak', ['run', 'com.spotify.Client']];
  return ['spotify', []];
}

class SpotifyApp extends EventEmitter {
  // devCommand: [cmd, args, env] to start instead of Spotify (the mock player in --dev).
  constructor({ devCommand = null } = {}) {
    super();
    this.devCommand = devCommand;
    this.matches = devCommand ? MOCK : REAL;
    this.ids = this._loadState(); // windows we've withdrawn and still look after
    this.released = this.ids.length > 0; // left over from the last run: rehide() sorts them out
    this.spy = null;
    this.timer = null;
    this.seen = new Set();
    this.lastHide = 0;
    this.busy = false;
    this.again = false;
  }

  get hidden() {
    return this.ids.length > 0;
  }

  // The real Spotify process, or the mock in dev. MPRIS tells us when it's fully up.
  processRunning() {
    return this.devCommand ? false : processRunning();
  }

  // Starts Spotify and hides its window as soon as it appears. Only windows that
  // appear after this point count: anything already open is left alone.
  async launch() {
    const before = await clientIds();
    const [cmd, args, env] = this.devCommand || spotifyCommand();
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: env ? { ...process.env, ...env } : process.env });
      child.on('error', (err) => this.emit('error', err));
      child.unref();
    } catch (err) {
      this.emit('error', err);
      return;
    }
    this._watch(before);
  }

  // Back on screen as a normal window; from now on it's yours (not hidden again).
  show() {
    this._stopWatch();
    const ids = this.ids;
    this._setIds([]);
    if (ids.length) this._helper('show', ids, false);
    this.emit('change');
  }

  // Skin hidden or quitting: put Spotify back in the taskbar, minimised. Synchronous
  // so it also runs during shutdown. Keeps the ids so `rehide()` can take it back.
  release() {
    this._stopWatch();
    // Only once: mapping a window that's already minimised would un-minimise it.
    if (!this.ids.length || this.released) return;
    this._helper('iconify', this.ids, true);
    this.released = true;
  }

  // Skin shown (again): hide it once more, unless you opened it meanwhile.
  async rehide() {
    if (!this.released || !this.ids.length) return;
    this.released = false;
    const keep = [];
    // 'withdrawn': still hidden from a skin that crashed. 'normal': you opened it, it's yours now.
    for (const id of this.ids) if (['iconic', 'withdrawn'].includes(await windowState(id))) keep.push(id);
    this._setIds(keep);
    if (keep.length) this._helper('withdraw', keep, false);
    this.emit('change');
  }

  // Spotify quit: its windows are gone.
  forget() {
    this.released = false;
    if (this.ids.length) this._setIds([]);
  }

  // Watching for the window

  _watch(before) {
    this._stopWatch();
    this.seen = new Set(before);
    this.lastHide = 0;
    const spy = spawn('xprop', ['-root', '-spy', '_NET_CLIENT_LIST'], { stdio: ['ignore', 'pipe', 'ignore'] });
    spy.stdout.on('data', (buf) => this._onList(clientList(buf.toString())));
    spy.on('error', (err) => console.warn(`[spotify] xprop unavailable, can't hide the window: ${err.message}`));
    this.spy = spy;
    const started = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      if (this.lastHide ? now - this.lastHide > GRACE_MS : now - started > WAIT_MS) this._stopWatch();
    }, 1000);
  }

  _stopWatch() {
    clearInterval(this.timer);
    this.timer = null;
    this.spy?.kill();
    this.spy = null;
  }

  async _onList(ids) {
    if (this.busy) {
      this.pending = ids;
      return;
    }
    this.busy = true;
    try {
      const found = [];
      for (const id of ids) {
        if (this.seen.has(id) && !this.ids.includes(id)) continue; // checked already, or open before we started
        this.seen.add(id);
        const c = await wmClass(id);
        if (c && this.matches(c)) found.push(id);
      }
      if (found.length && this.spy) {
        this._helper('withdraw', found, false);
        this._setIds([...new Set([...this.ids, ...found])]);
        this.lastHide = Date.now();
        console.log(`[spotify] window hidden (${found.map(toHex).join(', ')})`);
        this.emit('change');
      }
    } finally {
      this.busy = false;
    }
    if (this.pending) {
      const next = this.pending;
      this.pending = null;
      this._onList(next);
    }
  }

  // Helpers

  _helper(cmd, ids, sync) {
    const args = ['-I', HELPER, cmd, ...ids.map(toHex)];
    if (sync) {
      try {
        execFileSync('python3', args, { timeout: 3000, stdio: 'ignore' });
      } catch (err) {
        console.warn(`[spotify] ${cmd} failed: ${err.message}`);
      }
      return;
    }
    execFile('python3', args, { timeout: 3000 }, (err) => {
      if (err) console.warn(`[spotify] ${cmd} failed: ${err.message}`);
    });
  }

  _loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return Array.isArray(s.ids) ? s.ids.filter((n) => Number.isInteger(n) && n > 0) : [];
    } catch {
      return [];
    }
  }

  _setIds(ids) {
    this.ids = ids;
    try {
      if (ids.length) writeJsonAtomic(STATE_FILE, { ids });
      else fs.rmSync(STATE_FILE, { force: true });
    } catch (err) {
      console.warn(`[spotify] saving window state failed: ${err.message}`);
    }
  }
}

module.exports = { SpotifyApp, processRunning };
