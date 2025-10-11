// src/normalize.js
const fastSha256 = require('fast-sha256');

// Return origin (protocol + domain)
function originOf(u) {
  const x = new URL(u);
  return x.origin;
}

// Resolve relative URL to absolute
function absolute(u, base) {
  try {
    return new URL(u, base).href;
  } catch {
    return null;
  }
}

// Normalize whitespace
function trimAny(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// Generate deterministic SHA-256 fingerprint for object
function fp(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const hashBytes = fastSha256(bytes);       // ✅ call default export
  return 'sha256:' + Buffer.from(hashBytes).toString('hex');
}

module.exports = {
  originOf,
  absolute,
  trimAny,
  fp,
};
