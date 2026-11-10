'use strict';
// "Follows the song's pace" for the edge glow. For each song:
//
//  1. Lookup: asks Deezer's public catalogue (no key, no account) for the song's
//     tempo, sending only artist and title. Used at once as a starting tempo
//     (not yet lined up with the beat). Unknown songs simply have no lookup tempo.
//  2. Listen: about 8 s after the song starts playing, reads Spotify's own sound
//     stream (PulseAudio/PipeWire, Spotify's stream only; all speakers only if that
//     stream can't be found), finds the beats, and lines the pulse up with them.
//     The lookup only helps choose between candidate tempos.
//  3. Recheck: every ~45 s, listens for 4 s to correct any drift.
//
// Fallbacks: listen fails -> pulse at the lookup tempo (not lined up); both fail
// -> no pulse (the glow does its calm wave). Nothing is stored on disk: lookups are
// kept in memory for this session, audio is analysed in memory and dropped.
// Listening only happens while the pulse is actually shown (wanted).
//
// Emits 'beat' with { trackId, bpm, periodMs, anchorPos, aligned, source } where
// beats fall at track positions anchorPos + k * periodMs. source: 'listen' |
// 'lookup' | 'none'.

const { EventEmitter } = require('node:events');
const { execFile, spawn } = require('node:child_process');
const http = require('./http');
const { analyze } = require('./beat');

const RATE = 11025;
const FIRST_LISTEN_DELAY_MS = 1000;  // skip the very start (crossfades, silence)
const FIRST_LISTEN_S = 8;
const RECHECK_S = 4;
const RECHECK_EVERY_MS = 45_000;
const NO_AUDIO_TIMEOUT_MS = 2000;    // nothing arriving: give up on this listen
const LOOKUP_TIMEOUT_MS = 5000;
const LOOKUP_CACHE_MAX = 300;
const USER_AGENT = 'desktop-music-skin/0.2';

// The stream list is a few KB; 256 KB is plenty and caps what one call can hold.
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024 }, (err, out) => resolve(err ? '' : out));
  });
}

// "Song (feat. X) - Remastered 2011" -> "song"
function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*[([].*?(feat|ft\.|with|remaster|version|edit|mix|live|bonus).*?[)\]]/gi, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mix|live|mono|stereo).*$/i, '')
    .trim();
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const firstArtist = (a) => String(a || '').split(/,|&| feat\.? | x /i)[0].trim();

async function getJson(url) {
  const res = await http.get(url, {
    timeoutMs: LOOKUP_TIMEOUT_MS,
    maxBytes: 512 * 1024,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(res.body.toString('utf8'));
}

class Tempo extends EventEmitter {
  // matchStream(props) -> true for the player's own audio stream (pactl sink-input properties)
  constructor({ getState, matchStream }) {
    super();
    this.getState = getState;
    this.matchStream = matchStream;
    this.cache = new Map();   // "artist|title" -> bpm or 0 (unknown); memory only
    this.track = null;
    this.gen = 0;
    this.wanted = false;
    this.info = this._none('');
    this.listening = null;    // { child, gen }
    this.timer = null;
    this.lastListenAt = 0;
  }

  current() {
    return { ...this.info };
  }

  // Song changed (or player gone: track null).
  setTrack(track) {
    const id = track?.id || '';
    if (id === this.track?.id) return;
    this.gen++;
    this._stopListening();
    clearTimeout(this.timer);
    this.track = track || null;
    this.lookupBpm = 0;
    this.lastListenAt = 0;
    this._set(this._none(id));
    if (!track || !this._isMusic(track)) return;
    this._lookup(track, this.gen);
    this._schedule(FIRST_LISTEN_DELAY_MS);
  }

  // Whether the pulse is on screen (playing, panels awake, not covered, motion on).
  setWanted(on) {
    if (this.wanted === on) return;
    this.wanted = on;
    if (!on) {
      this._stopListening();
      clearTimeout(this.timer);
      return;
    }
    // Back on: listen soon (a short recheck if we already have the beat).
    this._schedule(this.info.aligned ? 500 : FIRST_LISTEN_DELAY_MS);
  }

  stop() {
    this.gen++;
    this._stopListening();
    clearTimeout(this.timer);
  }

  // Internals

  _none(trackId) {
    return { trackId, bpm: 0, periodMs: 0, anchorPos: 0, aligned: false, source: 'none' };
  }

  _set(info) {
    this.info = info;
    this.emit('beat', this.current());
  }

  _isMusic(track) {
    // Podcasts and ads have no beat worth following.
    return !/\/(episode|ad)\//.test(track.id) && !track.id.includes(':ad:') && !track.id.includes(':episode:');
  }

  async _lookup(track, gen) {
    const artist = firstArtist(track.artist);
    const title = cleanTitle(track.title);
    if (!artist || !title) return;
    const key = `${norm(artist)}|${norm(title)}`;
    let bpm = this.cache.get(key);
    if (bpm === undefined) {
      bpm = 0;
      try {
        const q = encodeURIComponent(`${artist} ${title}`);
        const found = await getJson(`https://api.deezer.com/search?q=${q}&limit=8`);
        const lenS = (track.lengthMs || 0) / 1000;
        const want = norm(title);
        const hits = (found?.data || []).filter((d) => norm(d.title_short || d.title) === want);
        // Prefer the same artist and length (a remix or live cut has a different tempo).
        hits.sort((a, b) => score(b) - score(a));
        function score(d) {
          let s = 0;
          if (norm(d.artist?.name).includes(norm(artist)) || norm(artist).includes(norm(d.artist?.name))) s += 2;
          if (lenS && Math.abs((d.duration || 0) - lenS) <= 4) s += 1;
          return s;
        }
        const hit = hits[0];
        if (hit?.id) {
          const detail = await getJson(`https://api.deezer.com/track/${Number(hit.id)}`);
          const b = Number(detail?.bpm);
          if (b >= 40 && b <= 250) bpm = b;
        }
      } catch (err) {
        console.warn(`[tempo] lookup failed: ${err.message}`);
        if (gen !== this.gen) return;
        bpm = undefined; // network trouble: don't cache, try again next time
      }
      if (bpm !== undefined) {
        if (this.cache.size >= LOOKUP_CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, bpm);
      }
    }
    if (gen !== this.gen || !bpm) return;
    this.lookupBpm = bpm;
    if (this.info.source === 'none') {
      // Starting tempo, not lined up with the beat yet.
      this._set({ trackId: track.id, bpm, periodMs: 60000 / bpm, anchorPos: 0, aligned: false, source: 'lookup' });
    }
  }

  _schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._listenNow(), ms);
  }

  async _listenNow() {
    clearTimeout(this.timer);
    const gen = this.gen;
    const st = this.getState();
    if (!this.wanted || !this.track || this.listening || !st?.running || st.status !== 'Playing') return;
    const recheck = this.info.source === 'listen';
    const secs = recheck ? RECHECK_S : FIRST_LISTEN_S;
    let result = await this._capture(secs, gen);
    if (gen !== this.gen) return;
    this.lastListenAt = Date.now();
    const heard = Boolean(result);
    if (result) this._useResult(result, recheck);
    result = null; // the audio is dropped here; only the tempo and beat time are kept
    if (!heard && !recheck) console.log('[tempo] no clear beat heard; ' + (this.lookupBpm ? 'using the lookup tempo' : 'calm wave'));
    if (this.wanted) this._schedule(RECHECK_EVERY_MS);
  }

  _useResult({ samples, startWall }, recheck) {
    const r = analyze(samples, RATE, recheck ? { nearBpm: this.info.bpm } : { priorBpm: this.lookupBpm });
    if (!r?.clear) return;
    const st = this.getState();
    if (!st?.running || st.status !== 'Playing' || st.track?.id !== this.track?.id) return;
    // Track position at the first beat we heard.
    const beatWall = startWall + r.phaseSec * 1000;
    const anchorPos = st.positionMs + (beatWall - st.positionAt) * (st.rate || 1);
    this._set({ trackId: this.track.id, bpm: r.bpm, periodMs: 60000 / r.bpm, anchorPos, aligned: true, source: 'listen' });
    console.log(`[tempo] ${recheck ? 'recheck' : 'beat'}: ${r.bpm.toFixed(1)} bpm (lookup ${this.lookupBpm || 'none'}), confidence ${r.confidence.toFixed(2)}`);
  }

  // Audio capture

  async _findSource() {
    const out = await run('pactl', ['-f', 'json', 'list', 'sink-inputs']);
    let inputs = [];
    try {
      inputs = JSON.parse(out || '[]');
    } catch {
      inputs = [];
    }
    const mine = inputs.filter((s) => this.matchStream(s.properties || {}) && !s.corked);
    if (mine.length) return ['--monitor-stream', String(mine[0].index)];
    // Fallback: everything the speakers play. Always an explicit ".monitor" source,
    // never a default (which could be a microphone).
    const sink = (await run('pactl', ['get-default-sink'])).trim();
    if (sink && /^[\w.\-:]+$/.test(sink)) return ['-d', `${sink}.monitor`];
    return null;
  }

  async _capture(secs, gen) {
    const src = await this._findSource();
    if (!src || gen !== this.gen) return null;
    return new Promise((resolve) => {
      const want = Math.round(secs * RATE);
      const child = spawn('parec', [...src, `--rate=${RATE}`, '--channels=1', '--format=float32le', '--raw', '--latency-msec=60'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      this.listening = { child, gen };
      // One buffer for the whole listen; pieces are copied straight into it (no
      // list of pieces, no second copy). float32le is the machine's own byte order
      // here (x86/ARM little-endian), so the samples are read in place.
      let samples = new Float32Array(want);
      const bytesOut = new Uint8Array(samples.buffer);
      const cap = bytesOut.length;
      let bytes = 0;
      let lastArrival = 0;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(noAudio);
        clearTimeout(hardStop);
        child.kill();
        if (this.listening?.child === child) this.listening = null;
        const out = samples;
        samples = null;
        if (!ok || gen !== this.gen) return resolve(null);
        const n = Math.floor(bytes / 4);
        // The last sample arrived at lastArrival; count back to the first one.
        resolve({ samples: n < want ? out.subarray(0, n) : out, startWall: lastArrival - (n / RATE) * 1000 });
      };
      const noAudio = setTimeout(() => finish(false), NO_AUDIO_TIMEOUT_MS);
      const hardStop = setTimeout(() => finish(bytes >= cap * 0.75), (secs + 3) * 1000);
      child.stdout.on('data', (b) => {
        if (done) return;
        clearTimeout(noAudio);
        const take = Math.min(b.length, cap - bytes);
        bytesOut.set(take === b.length ? b : b.subarray(0, take), bytes);
        bytes += take;
        lastArrival = Date.now();
        if (bytes >= cap) finish(true);
      });
      child.on('error', () => finish(false));
      child.on('exit', () => finish(bytes >= cap * 0.75));
    });
  }

  _stopListening() {
    if (this.listening) {
      this.listening.child.kill();
      this.listening = null;
    }
  }
}

module.exports = { Tempo, cleanTitle };
