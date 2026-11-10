'use strict';
// Small HTTPS GET for the main process, built on Node's own https module.
//
// Why not Electron's net.fetch: the first net.fetch starts Chromium's network
// stack in this process and in the network-service process, about 12 MB that
// stays for the session (measured). Node's https costs about 3 MB.
// Trade-offs (fine for this app): it ignores system proxy settings, checks
// certificates against Node's built-in list, and doesn't follow redirects.
//
//   get(url, { timeoutMs, headers, maxBytes }) -> { status, headers, body: Buffer }
// Rejects on network errors, timeout (covering the whole request), non-https
// URLs, or a body larger than maxBytes.

const https = require('node:https');

function get(url, { timeoutMs = 10_000, headers = {}, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error('bad URL'));
    }
    if (u.protocol !== 'https:') return reject(new Error('only https is allowed'));
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = https.get(u, { headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy();
          return done(reject, new Error('response too large'));
        }
        chunks.push(c);
      });
      res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks, size) }));
      res.on('error', (err) => done(reject, err));
    });
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new Error('timed out'));
    }, timeoutMs);
    req.on('error', (err) => done(reject, err));
  });
}

module.exports = { get };
