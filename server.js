'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const config = require('./lib/config');
const net = require('./lib/net');
const { CookieJar } = require('./lib/cookies');
const { tokenForOrigin, originForToken } = require('./lib/tokens');
const { rewriteHtml, rewriteCss } = require('./lib/rewrite');
const { renderClientRuntime } = require('./lib/client');
const { RateLimiter, ConcurrencyLimiter } = require('./lib/ratelimit');

const PUBLIC_DIR = path.join(__dirname, 'public');

const rateLimiter = new RateLimiter({
  windowMs: 60_000,
  max: config.rateLimitPerMinute,
  maxKeys: 20_000,
});
const concurrencyLimiter = new ConcurrencyLimiter(config.maxConcurrentRequests);

/**
 * The visitor's address.
 *
 * Behind a hosting proxy (Render, Railway, nginx, ...) the real client IP
 * arrives in X-Forwarded-For. X-Real-IP is used as a fallback.
 */
function clientIp(req) {
  if (config.trustProxyHeaders) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return first;
    }
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * The scheme the visitor used to reach this server.
 * Behind a hosting proxy TLS is terminated there, so the request that
 * reaches us is plain http even though the visitor used https.
 */
function clientProto(req) {
  if (config.trustProxyHeaders) {
    const forwarded = req.headers['x-forwarded-proto'];
    if (forwarded) {
      const first = String(forwarded).split(',')[0].trim().toLowerCase();
      if (first === 'https' || first === 'http') return first;
    }
  }
  return req.socket && req.socket.encrypted ? 'https' : 'http';
}

/* ------------------------------------------------------------------ *
 * Sessions (one cookie jar + per-session page context each)
 * ------------------------------------------------------------------ */

const sessions = new Map();

function getSession(req, res) {
  const cookies = parseCookieHeader(req.headers.cookie || '');
  let id = cookies.pid;
  let isNew = false;
  if (!id || !sessions.has(id)) {
    id = require('node:crypto').randomBytes(16).toString('hex');
    isNew = true;
    sessions.set(id, { id, jar: new CookieJar(), created: Date.now(), pages: new Map() });
  }
  const session = sessions.get(id);
  session.lastSeen = Date.now();
  // Collected rather than set immediately: writeHead() would otherwise
  // replace a Set-Cookie header set with setHeader().
  res.cookies = [
    `pid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.tokenTTL / 1000)}`,
  ];
  res.isNewSession = isNew;
  return session;
}

function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Proxy URL helpers
 * ------------------------------------------------------------------ */

/**
 * Build the proxy path for an absolute URL.
 *   https://example.com/a/b?x=1  ->  /p/example.com/a/b?x=1
 *
 * The token is the host only - the scheme is decided by the proxy, so the
 * http:// and https:// variants of a site share one URL.
 */
function buildProxyPath(absoluteUrl) {
  const url = new URL(absoluteUrl);
  const token = tokenForOrigin(url.host);
  if (!token) return null;
  return `/p/${token}${url.pathname}${url.search}${url.hash}`;
}

/* ------------------------------------------------------------------ *
 * Scheme selection
 *
 * One proxy token per host. The proxy decides the scheme itself: https
 * first, plain http as a fallback. The result is remembered so the extra
 * round trip only happens once per host.
 * ------------------------------------------------------------------ */

const hostSchemes = new Map(); // host -> 'https' | 'http'

function schemesFor(host) {
  const known = hostSchemes.get(host);
  return known ? [known] : ['https', 'http'];
}

function rememberScheme(host, scheme) {
  hostSchemes.set(host, scheme);
}

/**
 * Resolve a proxy path back to an absolute origin URL.
 */
function resolveProxyPath(pathname, search) {
  const m = /^\/p\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const token = decodeURIComponent(m[1]);
  const rest = m[2] || '/';
  const qs = search || '';

  const host = originForToken(token);
  if (!host) return null;

  return { kind: 'host', host, rest, search: qs, origin: null, token };
}

/**
 * Collect the cookies the browser sent to this proxy path.
 *
 * The browser stores each target's cookies on the proxy host with a
 * rewritten Path (`/p/<token>...`), so anything the browser sends here
 * already belongs to the site being proxied - except our own `pid`
 * session cookie, which is dropped.
 */
function browserCookiesFor(req) {
  const header = req.headers.cookie;
  if (!header) return '';

  const pairs = [];
  for (const part of String(header).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name || name === 'pid') continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs.join('; ');
}

/** Combine two Cookie header strings, first one wins on conflicts. */
function mergeCookies(primary, secondary) {
  const seen = new Set();
  const out = [];
  for (const source of [primary, secondary]) {
    if (!source) continue;
    for (const pair of String(source).split(';')) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const name = trimmed.split('=')[0].trim();
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(trimmed);
    }
  }
  return out.join('; ');
}

/**
 * Rewrite absolute URLs inside JavaScript that the browser would load as a
 * separate resource.
 *
 * Only the constructs that actually trigger a network fetch are touched:
 *   import("...")      dynamic import
 *   import "..."       static import
 *   new Worker("...")  web worker
 *   importScripts(...) classic worker
 *
 * Without this, a module loaded by an absolute URL would be fetched from the
 * original origin while the same module loaded by a relative URL would be
 * fetched through the proxy - the browser would evaluate it twice and
 * things like custom elements would be registered twice.
 */
function rewriteJsImports(code, baseUrl) {
  if (!code || code.indexOf('http') === -1) return code;

  const rewrite = (match, quote, url) => {
    if (!/^https?:\/\//i.test(url)) return match;
    let absolute;
    try {
      absolute = new URL(url, baseUrl).href;
    } catch {
      return match;
    }
    const proxied = buildProxyPath(absolute);
    if (!proxied) return match;
    return match.replace(url, proxied);
  };

  // import("url")  /  import('url')
  code = code.replace(/\bimport\s*\(\s*(['"])(https?:\/\/[^'"]+)\1/gi, rewrite);
  // import "url"
  code = code.replace(/\bimport\s+(['"])(https?:\/\/[^'"]+)\1/g, rewrite);
  // new Worker("url")  /  new SharedWorker("url")
  code = code.replace(/\bnew\s+(?:Shared)?Worker\s*\(\s*(['"])(https?:\/\/[^'"]+)\1/gi, rewrite);
  // importScripts("url")
  code = code.replace(/\bimportScripts\s*\(\s*(['"])(https?:\/\/[^'"]+)\1/gi, rewrite);

  return code;
}

/**
 * Rewrite a target's Set-Cookie so the browser can store it on the proxy
 * host.
 *
 * The Domain attribute is dropped (it belongs to the target site) and the
 * Path is rewritten to the proxy prefix of that site, so cookies from
 * different proxied sites never collide and each is sent back only to the
 * site it came from.
 */
function rewriteSetCookie(setCookie, targetUrl, req) {
  const parts = String(setCookie).split(';');
  if (!parts.length) return null;

  const first = parts[0];
  const eq = first.indexOf('=');
  if (eq < 1) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  let path = null;
  let secure = false;
  let sameSite = null;
  let maxAge = null;
  let expires = null;

  for (const raw of parts.slice(1)) {
    const seg = raw.trim();
    if (!seg) continue;
    const idx = seg.indexOf('=');
    const attr = (idx === -1 ? seg : seg.slice(0, idx)).trim().toLowerCase();
    const attrValue = idx === -1 ? '' : seg.slice(idx + 1).trim();
    if (attr === 'path') path = attrValue;
    else if (attr === 'secure') secure = true;
    else if (attr === 'samesite') sameSite = attrValue.toLowerCase();
    else if (attr === 'max-age') maxAge = attrValue;
    else if (attr === 'expires') expires = attrValue;
  }

  // Proxy path prefix for this site: /p/<host>
  const token = tokenForOrigin(new URL(targetUrl).host);
  const prefix = token ? `/p/${token}` : '/';

  let cookiePath = prefix;
  if (path && path.startsWith('/')) {
    // Map the target's path onto the proxy path, e.g. /account -> /p/<tok>/account
    cookiePath = `${prefix}${path === '/' ? '/' : path.replace(/\/$/, '')}`;
  }

  const isHttps = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  const out = [`${name}=${value}`, `Path=${cookiePath}`];
  if (maxAge !== null) out.push(`Max-Age=${maxAge}`);
  else if (expires) out.push(`Expires=${expires}`);
  if (sameSite) out.push(`SameSite=${sameSite}`);
  if (secure && isHttps) out.push('Secure');
  return out.join('; ');
}

/** Absolute target URL for a resolved proxy path. */
function targetUrlFor(resolved, scheme) {
  return `${scheme || 'https'}://${resolved.host}${resolved.rest}${resolved.search}`;
}

/**
 * Translate a header value that points at this proxy back into the real
 * address it refers to. Used for Referer / Origin so the target site sees
 * exactly what it would see if the visitor had gone there directly.
 */
function toRealUrl(value, selfHost) {
  if (!value || typeof value !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (selfHost && parsed.host !== selfHost) return value; // not ours -> pass through
  const m = /^\/p\/([^/]+)(\/.*)?$/.exec(parsed.pathname);
  if (!m) return value;
  const host = originForToken(decodeURIComponent(m[1]));
  if (!host) return value;
  const scheme = hostSchemes.get(host) || 'https';
  return `${scheme}://${host}${m[2] || '/'}${parsed.search}`;
}

/**
 * Did the request fail before it reached the server?
 *
 * These are the cases where trying the other scheme makes sense - a TLS
 * mismatch, a refused connection or a DNS failure. A response with an HTTP
 * error status means the server *was* reached, so no retry.
 */
function isConnectionError(err) {
  const code = err && err.code ? String(err.code) : '';
  const message = err && err.message ? String(err.message) : '';
  if (/^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPROTO|ETIMEDOUT|ECONNABORTED|ERR_SSL|ERR_TLS|EADDRNOTAVAIL|EPIPE)$/.test(code)) {
    return true;
  }
  if (/wrong version number|ERR_SSL|ERR_TLS|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|certificate|tls|ssl/i.test(message)) {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Response helpers
 * ------------------------------------------------------------------ */

function sendError(res, status, message, extraHeaders) {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${status}</title>
<style>body{background:#0f1218;color:#dfe6f2;font-family:system-ui,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:560px;padding:32px 36px;background:#171b24;border:1px solid #262c39;border-radius:14px}
h1{margin:0 0 8px;font-size:20px} p{color:#9aa6bb;line-height:1.6;font-size:14px}
code{background:#0f1218;padding:2px 6px;border-radius:5px;color:#7dd3fc}</style></head>
<body><div class="card"><h1>${status} — ${escapeHtml(titleFor(status))}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function titleFor(status) {
  const map = {
    400: 'Bad Request',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    500: 'Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return map[status] || 'Error';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/* ------------------------------------------------------------------ *
 * Main proxy handler
 * ------------------------------------------------------------------ */

async function handleProxy(req, res, resolved) {
  const session = getSession(req, res);

  let targetUrl = targetUrlFor(resolved, 'https');

  // Never proxy ourselves - that would create an infinite loop.
  const selfHost = String(req.headers.host || '').toLowerCase();
  try {
    const targetHost = new URL(targetUrl).host.toLowerCase();
    if (selfHost && (targetHost === selfHost || targetHost === selfHost.split(':')[0])) {
      sendError(res, 400, 'Refusing to proxy the proxy server itself.');
      return;
    }
  } catch {
    /* ignore */
  }
  let upstream = null;
  let lastError = null;

  const requestOptions = { method: req.method, headers: {}, body: null };

  // ---- build outgoing request -------------------------------------
  const headers = net.stripHopByHop(req.headers);
  // We handle decompression ourselves, but we still advertise support so
  // sites behave the same way they do for a real browser.
  headers['accept-encoding'] = 'gzip, deflate, br';
  headers['user-agent'] = req.headers['user-agent'] || config.fallbackUserAgent;
  headers['accept'] = req.headers.accept || config.fallbackUserAgentAccept;
  headers['accept-language'] = req.headers['accept-language'] || 'en-US,en;q=0.9';

  // Forward the real visitor address and the scheme they used.
  const visitorIp = clientIp(req);
  const visitorProto = clientProto(req);
  headers['x-forwarded-for'] = req.headers['x-forwarded-for']
    ? `${req.headers['x-forwarded-for']}, ${req.socket.remoteAddress || ''}`
    : req.socket.remoteAddress || '';
  headers['x-forwarded-proto'] = visitorProto;
  requestOptions.headers = headers;

  // The proxy's own public address, used to build an absolute Referer
  // header. Behind a hosting proxy the public host is in the Host header.
  const selfOrigin = `${visitorProto}://${req.headers.host || `localhost:${config.port}`}`;

  // Referer / Origin arrive pointing at the proxy - translate them back to
  // the real site so the target sees a normal request.
  const realReferer = toRealUrl(headers.referer, selfHost);
  if (realReferer) headers.referer = realReferer;
  else delete headers.referer;

  const realOrigin = toRealUrl(headers.origin, selfHost);
  if (realOrigin && /^https?:\/\//i.test(realOrigin)) headers.origin = realOrigin;
  else delete headers.origin;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const raw = await net.readBody(req, config.maxUploadSize);
    const contentType = req.headers['content-type'] || '';
    requestOptions.body = contentType.includes('application/x-www-form-urlencoded')
      ? raw.toString('utf8')
      : raw;
  }

  // ---- perform the request (https first, http as fallback) -------
  const candidates = schemesFor(resolved.host);
  for (const scheme of candidates) {
    targetUrl = targetUrlFor(resolved, scheme);
    headers.host = new URL(targetUrl).host;
    // Referer must be an absolute URL - a relative path makes many APIs
    // (and CDNs) reject the request with 400.
    if (!headers.referer) {
      headers.referer = `${new URL(targetUrl).origin}/`;
    }
    headers['x-forwarded-host'] = new URL(targetUrl).host;

    const cookieHeader = mergeCookies(
      session.jar.headerFor(targetUrl),
      browserCookiesFor(req)
    );
    if (cookieHeader) headers.cookie = cookieHeader;
    else delete headers.cookie;

    try {
      upstream = await net.rawRequest(targetUrl, requestOptions);
      lastError = null;
      rememberScheme(resolved.host, scheme);
      break;
    } catch (err) {
      lastError = err;
      // The other scheme is only tried when the request never reached the
      // server (TLS mismatch, connection refused, DNS failure).
      if (!isConnectionError(err)) break;
    }
  }

  if (!upstream) {
    sendError(res, 502, `Could not reach ${targetUrl}\n\n${lastError ? lastError.message : 'unknown error'}`);
    return;
  }

  const upstreamRes = upstream.res;
  const status = upstreamRes.statusCode || 502;

  // ---- collect response headers ----------------------------------
  const forwardedCookies = [];
  const outHeaders = {};

  // Everything is served from the proxy's own origin, so the browser treats
  // it as same-origin. But pages that use `crossorigin` (on <link
  // rel=preload as=script> for example) still issue a CORS request - and
  // without these headers the browser would fetch the file twice, executing
  // scripts twice and breaking custom elements.
  outHeaders['Access-Control-Allow-Origin'] = '*';
  outHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS';
  outHeaders['Access-Control-Allow-Headers'] = req.headers['access-control-request-headers'] || '*';
  outHeaders['Access-Control-Expose-Headers'] = '*';
  outHeaders['Timing-Allow-Origin'] = '*';
  outHeaders['Cross-Origin-Resource-Policy'] = 'cross-origin';
  for (const [key, value] of Object.entries(upstreamRes.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'set-cookie') continue; // handled by the jar
    if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') continue;
    if (lower === 'content-length') continue;
    if (lower === 'location') continue;
    // CORS is decided by the proxy, not by the target site.
    if (lower.startsWith('access-control-') || lower === 'cross-origin-resource-policy') continue;
    if (lower === 'timing-allow-origin') continue;
    outHeaders[key] = value;
  }

  // Location redirect -> point back into the proxy
  const location = upstreamRes.headers.location;
  if (location) {
    try {
      const abs = new URL(location, upstream.url).href;
      outHeaders.Location = buildProxyPath(abs) || abs;
    } catch {
      outHeaders.Location = location;
    }
  }

  // Store cookies from upstream
  const setCookies = upstreamRes.headers['set-cookie'];
  if (setCookies) {
    const list = Array.isArray(setCookies) ? setCookies : [setCookies];
    for (const sc of list) {
      session.jar.setFromHeader(sc, upstream.url);
      // Also hand the cookie to the browser so site JavaScript can read it
      // (CSRF tokens etc). The Domain is dropped and the Path is rewritten to
      // this origin's proxy prefix, which keeps cookies from different sites
      // separate while still working with document.cookie.
      const rewritten = rewriteSetCookie(sc, upstream.url, req);
      if (rewritten) forwardedCookies.push(rewritten);
    }
  }

  if (forwardedCookies.length) {
    outHeaders['Set-Cookie'] = forwardedCookies.concat(res.cookies || []);
  } else if (res.cookies && res.cookies.length) {
    outHeaders['Set-Cookie'] = res.cookies;
  }

  const contentType = upstreamRes.headers['content-type'] || '';
  const lowerType = contentType.toLowerCase();

  // ---- decide whether to rewrite the body ------------------------
  const shouldRewrite =
    (req.method === 'GET' || req.method === 'HEAD') &&
    (lowerType.includes('text/html') || lowerType.includes('application/xhtml+xml'));

  const shouldRewriteCss =
    (req.method === 'GET' || req.method === 'HEAD') && lowerType.includes('text/css');

  const shouldRewriteJs =
    (req.method === 'GET' || req.method === 'HEAD') &&
    (lowerType.includes('javascript') || lowerType.includes('application/x-javascript'));

  if (!shouldRewrite && !shouldRewriteCss && !shouldRewriteJs) {
    // stream binary / other content straight through
    outHeaders['X-Proxied-By'] = 'own-proxy';
    if (config.logRequests) console.log(`${status} ${upstream.url}`);
    res.writeHead(status, outHeaders);
    if (req.method === 'HEAD') {
      res.end();
      upstreamRes.destroy();
      return;
    }
    upstreamRes.pipe(res);
    upstreamRes.on('error', () => res.destroy());
    return;
  }

  // ---- buffer + rewrite ------------------------------------------
  let raw;
  try {
    raw = await bufferStream(upstreamRes, config.maxBufferSize);
  } catch (err) {
    sendError(res, 502, `Failed to read response: ${err.message}`);
    return;
  }

  const decoded = net.decompress(raw, upstreamRes.headers['content-encoding']);
  const charset = net.charsetFromContentType(contentType) || 'utf-8';
  const text = net.decodeText(decoded, charset);

  // The body was decompressed for rewriting, so the encoding header must go.
  for (const key of Object.keys(outHeaders)) {
    if (key.toLowerCase() === 'content-encoding') delete outHeaders[key];
  }

  let output = text;
  if (shouldRewrite) {
    const finalUrl = upstream.url;
    // The <base> must mirror the original page path so relative URLs resolve
    // to the same place they would on the real site.
    const baseHref = buildProxyPath(finalUrl.split('#')[0].split('?')[0]) || finalUrl;
    const finalToken = tokenForOrigin(new URL(finalUrl).host);
    const headExtra = buildHeadExtra(finalUrl, finalToken);
    output = rewriteHtml(text, {
      pageUrl: finalUrl,
      toProxy: (abs) => buildProxyPath(abs),
      baseHref,
      headExtra,
    });
    outHeaders['Content-Type'] = 'text/html; charset=utf-8';
  } else if (shouldRewriteCss) {
    const resolveBase = upstream.url;
    const resolve = (raw2) => {
      if (!raw2 || raw2.startsWith('data:')) return null;
      try {
        return buildProxyPath(new URL(raw2, resolveBase).href);
      } catch {
        return null;
      }
    };
    output = rewriteCss(text, resolve);
    outHeaders['Content-Type'] = 'text/css; charset=utf-8';
  } else if (shouldRewriteJs) {
    // Only the URLs that trigger a separate network fetch are rewritten;
    // everything else in the script is left untouched.
    output = rewriteJsImports(text, upstream.url);
    outHeaders['Content-Type'] = lowerType.includes('charset') ? contentType : `${contentType}; charset=utf-8`;
  }
  // JavaScript is passed through untouched: rewriting string literals inside
  // JS breaks site logic, and the injected runtime already redirects
  // fetch/XHR/open calls through the proxy.

  outHeaders['Content-Length'] = Buffer.byteLength(output, 'utf8');
  outHeaders['X-Proxied-By'] = 'own-proxy';
  outHeaders['X-Proxy-Target'] = upstream.url;

  if (config.logRequests) {
    console.log(`${status} ${upstream.url}`);
  }

  res.writeHead(status, outHeaders);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(output);
}

/**
 * Rewrite absolute URLs inside JavaScript so absolute-path fetches
 * performed by site scripts also stay inside the proxy.
 */
const PROXY_PATH_PREFIX = '/p/';

function buildHeadExtra(pageUrl, token) {
  const runtime = renderClientRuntime({
    base: buildProxyPath(pageUrl) || pageUrl,
    url: pageUrl,
    token,
  });
  return `<script data-ownproxy="1">${runtime}</script>`;
}

function bufferStream(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (limit && size > limit) {
        reject(new Error('Response too large'));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/* ------------------------------------------------------------------ *
 * Static files (proxy home page)
 * ------------------------------------------------------------------ */

function serveStatic(req, res, urlPath) {
  let filePath;
  if (urlPath === '/' || urlPath === '/index.html') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else if (urlPath === '/favicon.ico') {
    filePath = path.join(PUBLIC_DIR, 'favicon.svg');
  } else {
    const safe = path.normalize(urlPath).replace(/^(\.\.[\\/])+/, '');
    filePath = path.join(PUBLIC_DIR, safe);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      sendError(res, 403, 'Forbidden');
      return;
    }
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendError(res, 404, `Not found: ${urlPath}`);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.json': 'application/json; charset=utf-8',
    };
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `localhost:${config.port}`;
  const url = new URL(req.url, `http://${host}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    // ---- proxy route ------------------------------------------------
    if (pathname === '/p' || pathname.startsWith('/p/')) {
      // CORS preflight - answered locally, never forwarded.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
          'Access-Control-Max-Age': '86400',
          'Access-Control-Expose-Headers': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        res.end();
        return;
      }

      const resolved = resolveProxyPath(pathname, url.search);
      if (!resolved) {
        sendError(res, 404, 'Unknown proxy token. The link may have expired — try opening the site from the home page again.');
        return;
      }

      // Abuse protection: a public proxy needs a per-visitor budget.
      const limit = rateLimiter.check(clientIp(req));
      if (!limit.allowed) {
        res.writeHead(429, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Retry-After': String(limit.retryAfter),
        });
        res.end(`Too many requests. Slow down and try again in ${limit.retryAfter}s.\n`);
        return;
      }

      if (!concurrencyLimiter.tryAcquire()) {
        res.writeHead(503, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Retry-After': '5',
        });
        res.end('The proxy is busy. Please retry in a moment.\n');
        return;
      }

      try {
        await handleProxy(req, res, resolved);
      } finally {
        concurrencyLimiter.release();
      }
      return;
    }

    // ---- health ------------------------------------------------------
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          sessions: sessions.size,
          uptime: process.uptime(),
          active: concurrencyLimiter.active,
        })
      );
      return;
    }

    // ---- robots.txt ---------------------------------------------------
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nDisallow: /p/\n');
      return;
    }

    // ---- api: build a proxy link -------------------------------------
    if (pathname === '/api/proxy-url') {
      const target = url.searchParams.get('url');
      if (!target) {
        sendError(res, 400, 'Missing ?url=');
        return;
      }
      let abs;
      try {
        abs = new URL(/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(target) ? target : `https://${target}`).href;
      } catch {
        sendError(res, 400, `Invalid URL: ${target}`);
        return;
      }
      const proxyPath = buildProxyPath(abs);
      const publicOrigin = `${clientProto(req)}://${req.headers.host || `localhost:${config.port}`}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: abs, proxy: proxyPath, absolute: `${publicOrigin}${proxyPath}` }));
      return;
    }

    // ---- static -------------------------------------------------------
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, pathname);
      return;
    }

    sendError(res, 405, 'Method not allowed');
  } catch (err) {
    // Client closed the connection early - normal when a page navigates away.
    if (err && (err.code === 'ECONNRESET' || err.message === 'aborted')) return;
    console.error('[own-proxy] error:', err);
    if (!res.headersSent) sendError(res, 500, err.message);
    else res.destroy();
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - (session.lastSeen || session.created) > config.tokenTTL) sessions.delete(id);
  }
}
setInterval(cleanup, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log('');
    console.log('  own-proxy is running');
    console.log('  ------------------------------------------');
    console.log(`  Local:    http://${shown}:${config.port}/`);
    console.log(`  Proxy:    http://${shown}:${config.port}/p/<host>/<path>`);
    console.log('  Example:  http://' + shown + ':' + config.port + '/p/example');
    console.log('  ------------------------------------------');
    console.log('');
  });

  // Hosting platforms send SIGTERM before restarting or redeploying.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`\n[own-proxy] ${signal} received, shutting down.`);
      server.close(() => process.exit(0));
      // Do not hang forever on lingering keep-alive connections.
      setTimeout(() => process.exit(0), 10_000).unref();
    });
  }
}

module.exports = { server, buildProxyPath, resolveProxyPath, targetUrlFor };
