'use strict';
// Spotify over MPRIS (session D-Bus). Tracks the player, keeps a plain serialisable
// state, and sends controls. Emits 'state' (state, { trackChanged }) whenever
// something the UI shows changes.
//
// Spotify quirks handled here:
// - Shuffle and LoopStatus are writable, but a build may ignore writes. We check
//   the latest change only, retry once, and grey the button out only if it still
//   didn't apply. That's never permanent: it clears when Spotify announces a new
//   value itself, when the song changes, or when the button is clicked again.
// - It doesn't emit PropertiesChanged for Position (and is patchy for Shuffle), so
//   we re-read everything with GetAll on a slow timer while the window is visible.
// - It owns the bus name a moment before it exports its object, so attaching retries.
// - Old builds send "spotify:track:…" as the track id, which isn't an object path;
//   seeking then falls back to a relative Seek().

const { EventEmitter } = require('node:events');
const dbus = require('dbus-next');

const NAME = 'org.mpris.MediaPlayer2.spotify';
const PATH = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const COMMANDS = new Set(['PlayPause', 'Play', 'Pause', 'Next', 'Previous']);
const POLL_PLAYING_MS = 2000;
const POLL_IDLE_MS = 5000;
const VERIFY_MS = 1200; // how long Spotify gets to apply a Shuffle/LoopStatus change (then once more after a retry)
// The two settings the dock can change, and where each lives in the state.
const SETTINGS = {
  Shuffle: { key: 'shuffle', ok: 'shuffleOk', missing: 'shuffleMissing' },
  LoopStatus: { key: 'loop', ok: 'loopOk', missing: 'loopMissing' },
};
const LOOPS = new Set(['None', 'Playlist', 'Track']);
const POSITION_JUMP_MS = 1500; // re-sync the UI only when Spotify disagrees by more than this
const SEEK_SETTLE_MS = 1500;   // after a seek, Spotify may still report the old spot for a moment

function parseMetadata(md) {
  if (!md) return null;
  const v = (k) => md[k]?.value;
  const id = v('mpris:trackid') || '';
  const title = v('xesam:title') || '';
  if (!id && !title) return null;
  const artists = v('xesam:artist');
  return {
    id: String(id),
    title: String(title),
    artist: Array.isArray(artists) ? artists.filter(Boolean).join(', ') : String(artists || ''),
    album: String(v('xesam:album') || ''),
    artUrl: String(v('mpris:artUrl') || ''),
    lengthMs: Math.max(0, Math.round(Number(v('mpris:length') || 0) / 1000)),
  };
}

class Mpris extends EventEmitter {
  constructor(bus) {
    super();
    this.bus = bus;
    this.gen = 0;
    this.player = null;
    this.props = null;
    this.active = false;
    this.pollTimer = null;
    this.lastKey = '';
    this.seekAt = 0;
    this.checks = { Shuffle: { gen: 0, timer: null }, LoopStatus: { gen: 0, timer: null } };
    this.s = this._blank();
    this._onProps = this._onProps.bind(this);
    this._onSeeked = this._onSeeked.bind(this);
  }

  _blank() {
    return {
      running: false,
      status: 'Stopped',
      track: null,
      shuffle: false,
      shuffleOk: true,       // false: Spotify didn't apply our last change (greyed, still clickable)
      shuffleMissing: false, // true: Spotify doesn't offer the setting at all (greyed, not clickable)
      loop: 'None',          // repeat: None (off), Playlist (all), Track (one)
      loopOk: true,
      loopMissing: false,
      positionMs: 0,
      positionAt: Date.now(),
      rate: 1,
    };
  }

  // Public

  async start() {
    const obj = await this.bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
    this.dbusIface = obj.getInterface('org.freedesktop.DBus');
    this.dbusIface.on('NameOwnerChanged', (name, _old, owner) => {
      if (name !== NAME) return;
      if (owner) this._attach();
      else this._detach();
    });
    if (await this.dbusIface.NameHasOwner(NAME)) await this._attach();
    else this._emit(false, true);
  }

  state() {
    return { ...this.s, track: this.s.track && { ...this.s.track } };
  }

  // Polling only runs while the window is open and not covered/locked.
  setActive(on) {
    this.active = on;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (on && this.player) {
      this._refresh();
      this._schedulePoll();
    }
  }

  async command(cmd) {
    if (!this.player || !COMMANDS.has(cmd)) return;
    try {
      await this.player[cmd]();
    } catch (err) {
      console.warn(`[mpris] ${cmd} failed: ${err.message}`);
    }
    setTimeout(() => this._refresh(), 250);
  }

  setShuffle(on) {
    return this._setVerified('Shuffle', new dbus.Variant('b', Boolean(on)), Boolean(on));
  }

  setLoop(status) {
    if (!LOOPS.has(status)) return undefined;
    return this._setVerified('LoopStatus', new dbus.Variant('s', status), status);
  }

  // Sets a player property, then checks Spotify really applied it. Only the latest
  // request is checked: a newer click cancels the older check, so a quick second
  // click is never mistaken for Spotify ignoring the first. If the value isn't
  // there after VERIFY_MS it's sent once more; only if that fails too does the
  // button grey out (it stays clickable, and clears on its own, see _apply).
  async _setVerified(prop, variant, want) {
    const { key, ok, missing } = SETTINGS[prop];
    const check = this.checks[prop];
    const gen = ++check.gen;
    clearTimeout(check.timer);
    check.timer = null;
    if (!this.props || this.s[missing]) return;
    if (!this.s[ok]) {
      this.s[ok] = true; // clicking a greyed button tries again
      this._emit(false, true);
    }
    const attempt = async (isRetry) => {
      const props = this.props;
      if (!props) return;
      try {
        await props.Set(PLAYER, prop, variant);
      } catch (err) {
        console.warn(`[mpris] setting ${prop} failed: ${err.message}`);
      }
      if (gen !== check.gen) return; // a newer click took over
      check.timer = setTimeout(async () => {
        check.timer = null;
        await this._refresh();
        if (gen !== check.gen || !this.player) return; // newer click, or Spotify quit
        if (this.s[key] === want) return;
        if (!isRetry) {
          attempt(true);
          return;
        }
        console.warn(`[mpris] Spotify didn't apply ${prop}=${want} (tried twice); greying the button until it changes.`);
        this.s[ok] = false;
        this._emit(false, true);
      }, VERIFY_MS);
    };
    await attempt(false);
  }

  _cancelChecks() {
    for (const c of Object.values(this.checks)) {
      c.gen++;
      clearTimeout(c.timer);
      c.timer = null;
    }
  }

  async seek(ms) {
    const t = this.s.track;
    if (!this.player || !t) return;
    const target = Math.max(0, Math.min(Math.round(ms), t.lengthMs || Infinity));
    // Readings already on their way were taken before the seek: they'd snap the knob back.
    this.seekAt = Date.now();
    this._setPosition(target);
    try {
      if (t.id.startsWith('/')) await this.player.SetPosition(t.id, BigInt(target * 1000));
      else await this.player.Seek(BigInt(Math.round((target - this._positionNow()) * 1000)));
      this.seekAt = Date.now();
      this._setPosition(target);
      this._emit(false, true);
    } catch (err) {
      console.warn(`[mpris] seek failed: ${err.message}`);
    }
  }

  // Attach / detach

  async _attach() {
    const gen = ++this.gen;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const obj = await this.bus.getProxyObject(NAME, PATH);
        if (gen !== this.gen) return;
        const player = obj.getInterface(PLAYER);
        const props = obj.getInterface('org.freedesktop.DBus.Properties');
        if (!player || !props) throw new Error('player interface not exported yet');
        this._unhook();
        this.player = player;
        this.props = props;
        props.on('PropertiesChanged', this._onProps);
        player.on('Seeked', this._onSeeked);
        this.s.running = true;
        this._cancelChecks();
        Object.assign(this.s, { shuffleOk: true, shuffleMissing: false, loopOk: true, loopMissing: false });
        await this._refresh(true);
        if (this.active) this._schedulePoll();
        return;
      } catch (err) {
        if (gen !== this.gen) return;
        if (attempt === 11) console.warn(`[mpris] couldn't attach to Spotify: ${err.message}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  _unhook() {
    this.props?.removeListener('PropertiesChanged', this._onProps);
    this.player?.removeListener('Seeked', this._onSeeked);
    this.props = null;
    this.player = null;
  }

  _detach() {
    this.gen++;
    this._cancelChecks();
    this._unhook();
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const hadTrack = Boolean(this.s.track);
    this.s = this._blank();
    this._emit(hadTrack, true);
  }

  // Reading state

  _schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.active || !this.player) return;
    const ms = this.s.status === 'Playing' ? POLL_PLAYING_MS : POLL_IDLE_MS;
    this.pollTimer = setTimeout(async () => {
      await this._refresh();
      this._schedulePoll();
    }, ms);
  }

  async _refresh(force = false) {
    const props = this.props;
    if (!props) return;
    const startedAt = Date.now();
    try {
      const all = await props.GetAll(PLAYER);
      if (props !== this.props) return;
      this._apply(all, force, false, startedAt);
    } catch (err) {
      // The player can vanish between the name check and the call; NameOwnerChanged cleans up.
      if (this.player) console.warn(`[mpris] GetAll failed: ${err.message}`);
    }
  }

  // Signals from Spotify (as opposed to our own GetAll reads).
  _onProps(iface, changed) {
    if (iface !== PLAYER) return;
    this._apply(changed, false, true);
  }

  _onSeeked(pos) {
    this._setPosition(Number(pos) / 1000);
    this._emit(false, true);
  }

  _positionNow() {
    const s = this.s;
    if (s.status !== 'Playing') return s.positionMs;
    return s.positionMs + (Date.now() - s.positionAt) * s.rate;
  }

  _setPosition(ms) {
    this.s.positionMs = Math.max(0, ms);
    this.s.positionAt = Date.now();
  }

  _apply(c, force, fromSignal = false, readAt = Date.now()) {
    const s = this.s;
    let trackChanged = false;
    let jump = force;

    if (c.Metadata) {
      const t = parseMetadata(c.Metadata.value);
      const before = s.track;
      trackChanged = (before?.id || '') !== (t?.id || '') || (before?.title || '') !== (t?.title || '');
      s.track = t;
      if (trackChanged && !c.Position) {
        this._setPosition(0);
        jump = true;
      }
    }
    if (c.PlaybackStatus) {
      const status = c.PlaybackStatus.value;
      if (status !== s.status) {
        this._setPosition(this._positionNow()); // freeze or restart the clock at the current spot
        s.status = status;
        jump = true;
      }
    }
    if (c.Rate) s.rate = Number(c.Rate.value) || 1;
    for (const [prop, { key, ok, missing }] of Object.entries(SETTINGS)) {
      const v = c[prop]?.value;
      const value = prop === 'Shuffle' ? (v === undefined ? undefined : Boolean(v)) : (LOOPS.has(v) ? v : undefined);
      if (value !== undefined) {
        // Spotify announcing a new value itself (e.g. changed in its own window) clears a grey-out.
        if (fromSignal && value !== s[key] && !s[ok]) s[ok] = true;
        s[key] = value;
      } else if (force && !(prop in c)) {
        s[missing] = true; // not offered at all
        s[ok] = false;
      }
      // A new song: give a greyed (but offered) setting another chance.
      if (trackChanged && !s[missing]) s[ok] = true;
    }
    if (c.Position && !trackChanged && this._staleAfterSeek(Number(c.Position.value) / 1000, readAt)) {
      // ignore: a reading from before (or just after) our seek, still showing the old spot
    } else if (c.Position) {
      const reported = Number(c.Position.value) / 1000;
      if (Math.abs(reported - this._positionNow()) > POSITION_JUMP_MS || trackChanged) jump = true;
      this._setPosition(reported);
    }
    this._emit(trackChanged, jump);
  }

  // A position reading is stale if it was requested before the last seek, or arrives
  // within SEEK_SETTLE_MS of it and still disagrees (Spotify catches up a moment later).
  _staleAfterSeek(reportedMs, readAt) {
    if (!this.seekAt) return false;
    if (readAt < this.seekAt) return true;
    const settling = Date.now() - this.seekAt < SEEK_SETTLE_MS;
    return settling && Math.abs(reportedMs - this._positionNow()) > POSITION_JUMP_MS;
  }

  _emit(trackChanged, jump) {
    const s = this.s;
    const key = JSON.stringify([s.running, s.status, s.track, s.shuffle, s.shuffleOk, s.shuffleMissing, s.loop, s.loopOk, s.loopMissing]);
    if (key === this.lastKey && !trackChanged && !jump) return;
    this.lastKey = key;
    this.emit('state', this.state(), { trackChanged });
    if (this.active) this._schedulePoll(); // playing vs paused changes the poll rate
  }
}

module.exports = { Mpris, NAME };
