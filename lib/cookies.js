'use strict';

/**
 * Per-session cookie jar.
 *
 * Cookies are kept server side, keyed by the visitor's `pid` session id, so
 * we never have to deal with Domain/Path/Secure rewriting of the target's
 * Set-Cookie headers. When a proxied response sets a cookie we store it and
 * replay it on later requests to the same site.
 */

class CookieJar {
  constructor() {
    /** @type {Map<string, {name:string,value:string,domain:string,path:string,secure:boolean,hostOnly:boolean,expires:number}>} */
    this.cookies = new Map();
  }

  static key(domain, path, name) {
    return `${domain}|${path}|${name}`;
  }

  setFromHeader(setCookieHeader, requestUrl) {
    if (!setCookieHeader) return;
    const url = new URL(requestUrl);
    const parts = setCookieHeader.split(';');
    if (!parts.length) return;

    const first = parts[0];
    const eq = first.indexOf('=');
    if (eq < 1) return;

    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) return;

    let domain = url.hostname.toLowerCase();
    let hostOnly = true;
    let path = defaultPath(url.pathname);
    let secure = false;
    let expires = 0;
    let maxAge = null;
    let httpOnly = false;
    let sameSite = null;

    for (const raw of parts.slice(1)) {
      const seg = raw.trim();
      if (!seg) continue;
      const idx = seg.indexOf('=');
      const attr = (idx === -1 ? seg : seg.slice(0, idx)).trim().toLowerCase();
      const attrValue = idx === -1 ? '' : seg.slice(idx + 1).trim();

      switch (attr) {
        case 'domain': {
          const d = attrValue.replace(/^\./, '').toLowerCase();
          if (!d) break;
          // Only accept domains that cover the request host.
          if (url.hostname.toLowerCase() === d || url.hostname.toLowerCase().endsWith(`.${d}`)) {
            domain = d;
            hostOnly = false;
          }
          break;
        }
        case 'path':
          if (attrValue.startsWith('/')) path = attrValue;
          break;
        case 'secure':
          secure = true;
          break;
        case 'httponly':
          httpOnly = true;
          break;
        case 'samesite':
          sameSite = attrValue.toLowerCase();
          break;
        case 'max-age': {
          const n = parseInt(attrValue, 10);
          if (!Number.isNaN(n)) maxAge = n;
          break;
        }
        case 'expires': {
          const t = Date.parse(attrValue);
          if (!Number.isNaN(t)) expires = t;
          break;
        }
        default:
          break;
      }
    }

    let expiryTime = 0;
    if (maxAge !== null) expiryTime = Date.now() + maxAge * 1000;
    else if (expires) expiryTime = expires;

    const key = CookieJar.key(domain, path, name);
    if (expiryTime && expiryTime <= Date.now()) {
      this.cookies.delete(key);
      return;
    }

    this.cookies.set(key, {
      name,
      value,
      domain,
      path,
      secure,
      hostOnly,
      httpOnly,
      sameSite,
      expires: expiryTime,
    });
  }

  /** Build the `Cookie:` request header for a target URL. */
  headerFor(targetUrl) {
    const url = new URL(targetUrl);
    const host = url.hostname.toLowerCase();
    const isSecure = url.protocol === 'https:';
    const reqPath = url.pathname || '/';
    const now = Date.now();

    const parts = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expires && cookie.expires <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (cookie.secure && !isSecure) continue;
      if (cookie.hostOnly) {
        if (host !== cookie.domain) continue;
      } else if (!(host === cookie.domain || host.endsWith(`.${cookie.domain}`))) {
        continue;
      }
      if (!pathMatch(reqPath, cookie.path)) continue;
      parts.push(`${cookie.name}=${cookie.value}`);
    }
    return parts.join('; ');
  }

  clear() {
    this.cookies.clear();
  }

  get size() {
    return this.cookies.size;
  }
}

function defaultPath(pathname) {
  if (!pathname || pathname[0] !== '/') return '/';
  const idx = pathname.lastIndexOf('/');
  if (idx === 0) return '/';
  return pathname.slice(0, idx);
}

function pathMatch(requestPath, cookiePath) {
  if (cookiePath === '/') return true;
  if (requestPath === cookiePath) return true;
  if (requestPath.startsWith(cookiePath)) {
    if (cookiePath.endsWith('/')) return true;
    return requestPath[cookiePath.length] === '/';
  }
  return false;
}

module.exports = { CookieJar };
