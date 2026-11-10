'use strict';
// Synced lyrics for the current song. Where they come from, in order:
//
//  1. Your own file: ~/.config/spotify-skin/lyrics/"Artist - Title.lrc"
//     (case doesn't matter; "/" in a name is written as "_"). Always wins.
//  2. The disk cache: ~/.cache/spotify-skin/lyrics/<hash>.json, newest 500 songs.
//     "No lyrics" answers are remembered for 7 days so they aren't asked again.
//  3. LRCLIB (lrclib.net, free, no key or account). Sends only artist, title,
//     album and length. 8 s timeout; network trouble isn't cached (try again on the
//     next play), and an answer for a song that has changed by then is dropped.
//
// Only synced (timestamped) lyrics are used. Plain-only lyrics and instrumentals
// count as "no lyrics", and then nothing is shown at all.
// In memory: just the current song's lines.
//
// Emits 'lyrics' with { trackId, lines: [{ t, text }] | null }.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const http = require('./http');
const { CONFIG_DIR, CACHE_DIR, writeJsonAtomic } = require('./config');
const { cleanTitle } = require('./tempo');

const LOCAL_DIR = path.join(CONFIG_DIR, 'lyrics');
const CACHE = path.join(CACHE_DIR, 'lyrics');
const CACHE_MAX = 500;
const NONE_TTL_MS = 7 * 24 * 3600_000;
const TIMEOUT_MS = 8000;
const MAX_LRC_BYTES = 512 * 1024;
const USER_AGENT = 'spotify-skin/0.1 (https://github.com/shahmerrkhan/spotify-skin)';
const DEFAULT_BASE = 'https://lrclib.net';

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const firstArtist = (a) => String(a || '').split(/,|&| feat\.? | x /i)[0].trim();

// LRC text -> [{ t (ms), text }] sorted by time, or null if nothing is timestamped.
// Handles several stamps on one line, [offset:±ms], and strips word-level <mm:ss.xx> tags.
function parseLrc(src) {
  const out = [];
  let offset = 0;
  for (const raw of String(src || '').split(/\r?\n/)) {
    const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) {
      offset = Number(off[1]);
      continue;
    }
    const stamps = [];
    let rest = raw.trim();
    let m;
    while ((m = rest.match(/^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/))) {
      stamps.push(Number(m[1]) * 60_000 + Math.round(Number(m[2].replace(':', '.')) * 1000));
      rest = rest.slice(m[0].length);
    }
    if (!stamps.length) continue;
    const text = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim();
    for (const t of stamps) out.push({ t, text });
  }
  if (!out.length) return null;
  // A positive offset means the lyrics should show earlier.
  for (const l of out) l.t = Math.max(0, l.t - offset);
  out.sort((a, b) => a.t - b.t);
  // Nothing but empty lines isn't lyrics.
  return out.some((l) => l.text) ? out : null;
}

class Lyrics extends EventEmitter {
  constructor({ base } = {}) {
    super();
    this.base = base || DEFAULT_BASE;
    this.enabled = true;
    this.trackId = '';
    this.lines = null;
    this.gen = 0;
    this.track = null;
  }

  current() {
    return { trackId: this.trackId, lines: this.enabled ? this.lines : null };
  }

  setEnabled(on) {
    on = Boolean(on);
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      const t = this.track;
      this.trackId = '';
      this.setTrack(t); // look up the song that's on now
    } else {
      this.gen++;
      this.lines = null;
      this.emit('lyrics', this.current());
    }
  }

  setTrack(track) {
    this.track = track || null;
    const id = track?.id || '';
    if (id === this.trackId) return;
    this.trackId = id;
    this.lines = null;
    const gen = ++this.gen;
    this.emit('lyrics', this.current()); // clear the old song's lines at once
    if (!track || !this.enabled || !this._isMusic(track)) return;
    this._find(track, gen).then((lines) => {
      if (gen !== this.gen) return; // the song changed meanwhile
      this.lines = lines;
      if (lines) this.emit('lyrics', this.current());
    }, (err) => console.warn(`[lyrics] ${err.message}`));
  }

  stop() {
    this.gen++;
  }

  // Internals

  _isMusic(track) {
    return !/\/(episode|ad)\//.test(track.id) && !track.id.includes(':ad:') && !track.id.includes(':episode:');
  }

  async _find(track, gen) {
    const local = await this._local(track);
    if (local !== undefined) return local;
    const key = this._key(track);
    const cached = this._cacheRead(key);
    if (cached !== undefined) return cached;
    let lines;
    try {
      lines = await this._lrclib(track);
    } catch (err) {
      console.warn(`[lyrics] lookup failed: ${err.message}`);
      return null; // offline / slow / server trouble: not cached, try again next time
    }
    this._cacheWrite(key, lines); // a real answer, even if the song has changed since
    return lines;
  }

  // Your own .lrc file, if there is one: lines, or undefined to keep looking.
  async _local(track) {
    let names;
    try {
      names = await fs.promises.readdir(LOCAL_DIR);
    } catch {
      return undefined;
    }
    const safe = (s) => String(s).replace(/\//g, '_').trim().toLowerCase();
    const wanted = new Set();
    for (const a of [track.artist, firstArtist(track.artist)]) {
      for (const t of [track.title, cleanTitle(track.title)]) {
        if (a && t) wanted.add(`${safe(a)} - ${safe(t)}.lrc`);
      }
    }
    const hit = names.find((n) => wanted.has(n.toLowerCase()));
    if (!hit) return undefined;
    try {
      const file = path.join(LOCAL_DIR, hit);
      const st = await fs.promises.stat(file);
      if (!st.isFile() || st.size > MAX_LRC_BYTES) return undefined;
      const lines = parseLrc(await fs.promises.readFile(file, 'utf8'));
      if (!lines) console.warn(`[lyrics] ${hit} has no timestamped lines; ignored`);
      return lines || undefined;
    } catch (err) {
      console.warn(`[lyrics] couldn't read ${hit}: ${err.message}`);
      return undefined;
    }
  }

  _key(track) {
    const s = `${norm(firstArtist(track.artist))}|${norm(cleanTitle(track.title))}|${Math.round((track.lengthMs || 0) / 1000)}`;
    return crypto.createHash('sha1').update(s).digest('hex');
  }

  // lines | null ("no lyrics", still fresh) | undefined (not cached / expired)
  _cacheRead(key) {
    const file = path.join(CACHE, `${key}.json`);
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!c.lines) return Date.now() - c.at < NONE_TTL_MS ? null : undefined;
      if (!Array.isArray(c.lines)) return undefined;
      const now = new Date();
      fs.utimesSync(file, now, now); // recently used: kept longest when pruning
      return c.lines.filter((l) => Number.isFinite(l?.t) && typeof l.text === 'string');
    } catch {
      return undefined;
    }
  }

  _cacheWrite(key, lines) {
    try {
      fs.mkdirSync(CACHE, { recursive: true });
      writeJsonAtomic(path.join(CACHE, `${key}.json`), { at: Date.now(), lines: lines || null });
      this._prune();
    } catch (err) {
      console.warn(`[lyrics] cache write failed: ${err.message}`);
    }
  }

  _prune() {
    let files;
    try {
      files = fs.readdirSync(CACHE).filter((f) => /^[a-f0-9]{40}\.json$/.test(f));
    } catch {
      return;
    }
    if (files.length <= CACHE_MAX) return;
    const byAge = files
      .map((f) => {
        try {
          return { f, m: fs.statSync(path.join(CACHE, f)).mtimeMs };
        } catch {
          return { f, m: 0 };
        }
      })
      .sort((a, b) => b.m - a.m);
    for (const { f } of byAge.slice(CACHE_MAX)) fs.rmSync(path.join(CACHE, f), { force: true });
  }

  async _get(pathAndQuery) {
    const res = await http.get(`${this.base}${pathAndQuery}`, {
      timeoutMs: TIMEOUT_MS,
      maxBytes: 1024 * 1024,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(res.body.toString('utf8'));
  }

  // lines, or null for "LRCLIB has no synced lyrics for this song"; throws on network trouble.
  async _lrclib(track) {
    const lenS = Math.round((track.lengthMs || 0) / 1000);
    const use = (rec) => (rec && !rec.instrumental && rec.syncedLyrics ? parseLrc(rec.syncedLyrics) : null);
    // Exact match first (artist, title, album, length within ±2 s on their side).
    if (track.album && lenS) {
      const q = new URLSearchParams({
        artist_name: track.artist, track_name: track.title, album_name: track.album, duration: String(lenS),
      });
      const rec = await this._get(`/api/get?${q}`);
      if (rec?.instrumental) return null;
      const lines = use(rec);
      if (lines) return lines;
    }
    // Otherwise search by artist + title and take the closest length (album names differ a lot).
    const q = new URLSearchParams({ artist_name: firstArtist(track.artist), track_name: cleanTitle(track.title) || track.title });
    const found = await this._get(`/api/search?${q}`);
    const want = norm(cleanTitle(track.title) || track.title);
    const hits = (Array.isArray(found) ? found : [])
      .filter((r) => r && norm(cleanTitle(r.trackName || r.name)) === want)
      .filter((r) => !lenS || Math.abs(Number(r.duration) - lenS) <= 3);
    hits.sort((a, b) => Math.abs(a.duration - lenS) - Math.abs(b.duration - lenS));
    if (hits[0]?.instrumental) return null;
    for (const r of hits) {
      const lines = use(r);
      if (lines) return lines;
    }
    return null;
  }
}

module.exports = { Lyrics, parseLrc, LOCAL_DIR };
