'use strict';

/**
 * Proxy URL tokens.
 *
 * A proxy URL looks like:   /p/<host>/<original/path?query>
 *
 * The token is simply the target host (including the port when there is
 * one). The scheme is *not* part of the token on purpose:
 *
 *   - A site often references itself with both http:// and https://. If the
 *     scheme were part of the token the browser would fetch the same script
 *     under two different URLs, evaluate it twice and register custom
 *     elements twice.
 *   - With one token per host the proxy picks the working scheme itself:
 *     https first, plain http as a fallback (checked and remembered).
 *
 * The format is reversible and stateless, so links keep working after a
 * server restart and the in-page runtime can compute the exact same URL as
 * the server.
 */

const HOST_TO_TOKEN = new Map(); // host -> token
const TOKEN_TO_HOST = new Map(); // token -> host

function normalizeHost(host) {
  if (!host) return null;
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) return null;
  // Basic hostname validation - no spaces, slashes or other path chars.
  if (!/^[a-z0-9._:\-%]+$/.test(value)) return null;
  return value;
}

/** Get the token for a host (or a full origin). Deterministic. */
function tokenForOrigin(origin) {
  let host = null;
  const text = String(origin || '');
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(text)) {
    try {
      host = new URL(text).host;
    } catch {
      host = null;
    }
  } else {
    host = text;
  }

  const normalized = normalizeHost(host);
  if (!normalized) return null;
  HOST_TO_TOKEN.set(normalized, normalized);
  TOKEN_TO_HOST.set(normalized, normalized);
  return normalized;
}

/**
 * Resolve a token back to a host string, or null when unknown/invalid.
 */
function originForToken(token) {
  if (!token) return null;
  const known = TOKEN_TO_HOST.get(token);
  if (known) return known;
  const host = normalizeHost(token);
  if (!host) return null;
  return host;
}

/** All known host -> token pairs (diagnostics). */
function tokenMap() {
  const out = {};
  for (const [host, token] of HOST_TO_TOKEN) out[host] = token;
  return out;
}

module.exports = { tokenForOrigin, originForToken, tokenMap, normalizeHost };
