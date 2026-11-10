'use strict';
// Cover art cache: downloads Spotify's cover once, keeps it on disk with a small
// thumbnail, and serves both to the UI as app://skin/art/<name>.
// Only i.scdn.co (Spotify's image CDN) is fetched; file:// is allowed in --dev for the mock player.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { nativeImage } = require('electron');
const { CACHE_DIR } = require('./config');
const http = require('./http');

const ART_DIR = path.join(CACHE_DIR, 'art');
const KEEP = 30;                     // covers kept on disk (plus anything the history still shows)
const MAX_BYTES = 8 * 1024 * 1024;
const THUMB_PX = 128;
const NAME_RE = /^[a-f0-9]{40}(?:-t)?\.jpg$/;

const inflight = new Map();

function normalize(url, allowFile) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // Older Spotify builds report open.spotify.com/image/<id>, which redirects to the CDN.
  if (u.protocol === 'https:' && u.hostname === 'open.spotify.com' && u.pathname.startsWith('/image/')) {
    u = new URL(`https://i.scdn.co${u.pathname}`);
  }
  if (u.protocol === 'https:' && u.hostname === 'i.scdn.co') return u;
  if (allowFile && u.protocol === 'file:') return u;
  return null;
}

async function readSource(u) {
  if (u.protocol === 'file:') {
    const file = decodeURIComponent(u.pathname);
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > MAX_BYTES * 4) throw new Error('art file missing or too large');
    return fs.promises.readFile(file);
  }
  const res = await http.get(u.href, { timeoutMs: 10_000, maxBytes: MAX_BYTES });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  if (!String(res.headers['content-type']).startsWith('image/')) throw new Error('not an image');
  return res.body;
}

function writeAtomic(file, buf) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

// Normalises any source to a JPEG (decoding big local files once here keeps the
// renderer from holding huge bitmaps) and writes a small thumbnail next to it.
function store(name, buf) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) throw new Error('could not decode image');
  const { width, height } = img.getSize();
  const fit = (px) => ({ ...(width >= height ? { width: px } : { height: px }), quality: 'good' });
  const big = Math.max(width, height) > 1000 ? img.resize(fit(1000)) : img;
  writeAtomic(path.join(ART_DIR, `${name}.jpg`), big.toJPEG(90));
  writeAtomic(path.join(ART_DIR, `${name}-t.jpg`), img.resize(fit(THUMB_PX)).toJPEG(85));
}

// Returns the cache name (without extension) or null if the URL isn't allowed or the fetch fails.
async function get(url, { allowFile = false, keep = [] } = {}) {
  const u = normalize(url, allowFile);
  if (!u) return null;
  const name = crypto.createHash('sha1').update(u.href).digest('hex');
  const file = path.join(ART_DIR, `${name}.jpg`);
  if (fs.existsSync(file) && fs.existsSync(path.join(ART_DIR, `${name}-t.jpg`))) {
    const now = new Date();
    fs.utimes(file, now, now, () => {});
    return name;
  }
  if (inflight.has(name)) return inflight.get(name);
  const job = (async () => {
    try {
      fs.mkdirSync(ART_DIR, { recursive: true });
      store(name, await readSource(u));
      prune([name, ...keep]);
      return name;
    } catch (err) {
      console.warn(`[art] ${u.protocol === 'file:' ? 'local file' : u.hostname}: ${err.message}`);
      return null;
    } finally {
      inflight.delete(name);
    }
  })();
  inflight.set(name, job);
  return job;
}

function prune(keep) {
  const keepSet = new Set(keep.filter(Boolean));
  let files;
  try {
    files = fs.readdirSync(ART_DIR).filter((f) => /^[a-f0-9]{40}\.jpg$/.test(f));
  } catch {
    return;
  }
  const byAge = files
    .map((f) => ({ f, t: fs.statSync(path.join(ART_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of byAge.slice(KEEP)) {
    const name = f.slice(0, 40);
    if (keepSet.has(name)) continue;
    fs.rmSync(path.join(ART_DIR, f), { force: true });
    fs.rmSync(path.join(ART_DIR, `${name}-t.jpg`), { force: true });
  }
}

// For the app:// protocol handler: maps a requested file name to its path, or null.
function resolve(fileName) {
  return NAME_RE.test(fileName) ? path.join(ART_DIR, fileName) : null;
}

module.exports = { get, resolve, ART_DIR };
