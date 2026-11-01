'use strict';

/**
 * HTML / CSS rewriter.
 *
 * Everything the browser would request is rewritten to a proxy path so the
 * session stays inside the proxy:
 *
 *   <a href="https://example.com/x">   ->  <a href="/p/<token>/x">
 *   <img src="/img/a.png">             ->  <img src="/p/<token>/img/a.png">
 *   style="background:url(x.png)"       ->  style="background:url(/p/<token>/x.png)"
 */

const SKIP_SCHEME_RE =
  /^(data|mailto|tel|sms|javascript|blob|about|ftp|file|ws|wss|magnet|news|irc|intent|market|chrome-extension|moz-extension):/i;

const PROXY_PREFIX = '/p/';

/** Attributes that hold a URL, per tag. */
const TAG_URL_ATTRS = {
  a: ['href'],
  area: ['href'],
  link: ['href'],
  img: ['src', 'longdesc'],
  script: ['src'],
  iframe: ['src'],
  frame: ['src'],
  embed: ['src'],
  source: ['src'],
  audio: ['src'],
  video: ['src', 'poster'],
  track: ['src'],
  input: ['src', 'formaction'],
  button: ['formaction'],
  form: ['action'],
  object: ['data'],
  body: ['background'],
  td: ['background'],
  th: ['background'],
  blockquote: ['cite', 'longdesc'],
  q: ['cite'],
  del: ['cite'],
  ins: ['cite'],
  use: ['href', 'xlink:href'],
  image: ['href', 'xlink:href'],
};

const LAZY_ATTRS = ['data-src', 'data-original', 'data-href', 'data-lazy-src'];

const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:._-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function isProxyPath(value) {
  return typeof value === 'string' && value.startsWith(PROXY_PREFIX);
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  '#39': "'",
  '#x27': "'",
};

/** Decode the HTML entities that commonly appear inside URL attributes. */
function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name) => {
    const key = name.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (Number.isInteger(code) && code > 0 && code < 0x110000) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
    }
    return match;
  });
}

/**
 * Build a resolver that turns any URL found in a document into a proxy path.
 *
 * @param {(absoluteUrl:string)=>string} toProxy
 * @param {string} defaultBase absolute URL relative paths resolve against
 */
function makeResolver(toProxy, defaultBase) {
  return function resolve(raw, base) {
    if (typeof raw !== 'string') return null;
    const value = decodeEntities(raw).trim();
    if (!value) return null;
    if (value.startsWith('#')) return null;
    if (SKIP_SCHEME_RE.test(value)) return null;
    if (isProxyPath(value)) return null;
    let absolute;
    try {
      absolute = new URL(value, base || defaultBase).href;
    } catch {
      return null;
    }
    const proxied = toProxy(absolute);
    return proxied || null;
  };
}

function parseSrcset(value) {
  const out = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i++;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !/[\s,]/.test(value[i])) i++;
    const url = value.slice(start, i);
    while (i < value.length && /\s/.test(value[i])) i++;
    const descStart = i;
    while (i < value.length && value[i] !== ',') i++;
    const desc = value.slice(descStart, i).trim();
    out.push({ url, desc });
    if (i < value.length) i++;
  }
  return out;
}

function rewriteSrcset(value, resolve) {
  const entries = parseSrcset(value);
  if (!entries.length) return value;
  let changed = false;
  const rebuilt = entries.map((entry) => {
    const proxied = resolve(entry.url);
    if (proxied && proxied !== entry.url) {
      changed = true;
      return entry.desc ? `${proxied} ${entry.desc}` : proxied;
    }
    return entry.desc ? `${entry.url} ${entry.desc}` : entry.url;
  });
  return changed ? rebuilt.join(', ') : value;
}

/* ------------------------------------------------------------------ *
 * CSS
 * ------------------------------------------------------------------ */

const CSS_URL_RE = /url\(\s*([^)]*?)\s*\)/gi;
const CSS_QUOTES = /^(&quot;|&#0*34;|&#x0*22;|"|')(.*)\1$/is;

/**
 * Pull the URL out of a `url(...)` token. Handles plain, quoted and
 * entity-quoted forms (CSS inside HTML often uses &quot;).
 */
function cssUrlValue(inner) {
  let value = String(inner).trim();
  const quoted = CSS_QUOTES.exec(value);
  if (quoted) value = quoted[2].trim();
  return value;
}

function rewriteCss(css, resolve) {
  if (!css) return css;

  // url(...) references
  css = css.replace(CSS_URL_RE, (match, inner) => {
    const url = cssUrlValue(inner);
    if (!url || SKIP_SCHEME_RE.test(url) || url.startsWith('#')) return match;
    const proxied = resolve(url);
    if (!proxied) return match;
    return `url("${proxied}")`;
  });

  // @import "file.css"
  css = css.replace(/@import\s+(['"])([^'"]+)\1/g, (match, quote, url) => {
    const proxied = resolve(url);
    if (!proxied) return match;
    return `@import ${quote}${proxied}${quote}`;
  });
  return css;
}

/* ------------------------------------------------------------------ *
 * HTML
 * ------------------------------------------------------------------ */

function parseAttributes(attrsText) {
  const result = {};
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(attrsText)) !== null) {
    const name = match[1].toLowerCase();
    let value = '';
    if (match[3] !== undefined) value = match[3];
    else if (match[4] !== undefined) value = match[4];
    else if (match[5] !== undefined) value = match[5];
    result[name] = { raw: match[0], name: match[1], value, hasValue: match[2] !== undefined };
  }
  return result;
}

function rebuildTag(tagName, attrs, overrides) {
  const parts = [`<${tagName}`];
  for (const [key, info] of Object.entries(attrs)) {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    parts.push(` ${info.raw}`);
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      parts.push(` ${key}="${escapeAttr(value)}"`);
    }
  }
  parts.push('>');
  return parts.join('');
}

function rewriteMeta(attrs, resolve) {
  const httpEquiv = ((attrs['http-equiv'] || attrs.httpequiv || {}).value || '').toLowerCase();
  const content = attrs.content ? attrs.content.value : '';

  if (httpEquiv === 'refresh' && content) {
    const m = /url\s*=\s*(['"]?)([^'";]+)\1/i.exec(content);
    if (m) {
      const proxied = resolve(m[2]);
      if (proxied) {
        const next = content.replace(m[0], `url=${proxied}`);
        return rebuildTag('meta', attrs, { content: next });
      }
    }
    return null;
  }

  if (httpEquiv === 'content-security-policy' || httpEquiv === 'content-security-policy-report-only') {
    return ''; // would block our injected resources
  }

  if (attrs.charset !== undefined) {
    return rebuildTag('meta', attrs, { charset: 'utf-8' });
  }

  if (httpEquiv === 'content-type' && content) {
    return rebuildTag('meta', attrs, { content: content.replace(/charset\s*=\s*[^;\s]+/i, 'charset=utf-8') });
  }

  return null;
}

function rewriteTagOpen(tagName, attrsText, resolve) {
  const name = tagName.toLowerCase();

  if (name === 'base') return ''; // we inject our own
  if (name === 'meta') {
    const attrs = parseAttributes(attrsText);
    const replacement = rewriteMeta(attrs, resolve);
    if (replacement !== null) return replacement;
  }

  const urlAttrs = new Set(TAG_URL_ATTRS[name] || []);
  for (const lazy of LAZY_ATTRS) urlAttrs.add(lazy);

  const attrs = parseAttributes(attrsText);
  const overrides = {};
  let changed = false;

  for (const [key, info] of Object.entries(attrs)) {
    const value = info.value;
    if (!value) continue;

    if (SRCSET_ATTRS.has(key)) {
      const next = rewriteSrcset(value, resolve);
      if (next !== value) {
        overrides[key] = next;
        changed = true;
      }
      continue;
    }

    if (key === 'style') {
      const next = rewriteCss(value, resolve);
      if (next !== value) {
        overrides[key] = next;
        changed = true;
      }
      continue;
    }

    if (!urlAttrs.has(key)) continue;

    const proxied = resolve(value);
    if (proxied && proxied !== value) {
      overrides[key] = proxied;
      changed = true;
    }
  }

  if (!changed) return null;
  return rebuildTag(tagName, attrs, overrides);
}

/**
 * Rewrite a full HTML document.
 *
 * @param {string} html
 * @param {object} options
 * @param {string} options.pageUrl    absolute URL of the page being proxied
 * @param {(abs:string)=>string} options.toProxy
 * @param {string} options.baseHref   proxy path to use as <base href>
 * @param {string} options.headExtra  extra markup injected into <head>
 */
function rewriteHtml(html, options) {
  const { pageUrl, toProxy, baseHref, headExtra } = options;

  // 1. Detect the page's own <base href> so relative URLs resolve like the
  //    original site intends.
  let resolveBase = pageUrl;
  const baseMatch = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+))/i.exec(html);
  if (baseMatch) {
    const raw = baseMatch[1] || baseMatch[2] || baseMatch[3];
    try {
      resolveBase = new URL(raw, pageUrl).href;
    } catch {
      resolveBase = pageUrl;
    }
  }

  const resolve = makeResolver(toProxy, resolveBase);

  // 2. Drop the original <base> tags.
  html = html.replace(/<base\b[^>]*>/gi, '');

  // 3. Extract <script> / <style> elements. Their *inner* content must not
  //    be treated as markup, but their opening tags still need rewriting.
  const blocks = [];
  html = html.replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi,
    (m, openAttrs, inner) => {
      const key = `\u0000BLOCK${blocks.length}\u0000`;
      blocks.push({ key, tag: 'style', openAttrs, inner, isCss: true });
      return key;
    }
  );
  html = html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
    (m, openAttrs, inner) => {
      const key = `\u0000BLOCK${blocks.length}\u0000`;
      blocks.push({ key, tag: 'script', openAttrs, inner, isCss: false });
      return key;
    }
  );

  // 4. Rewrite the CSS inside <style> blocks.
  for (const block of blocks) {
    if (!block.isCss) continue;
    block.inner = rewriteCss(block.inner, resolve);
  }

  // 5. Rewrite markup.
  html = html.replace(TAG_RE, (match, closing, tagName, attrsText) => {
    if (closing) return match;
    const rewritten = rewriteTagOpen(tagName, attrsText, resolve);
    return rewritten === null ? match : rewritten;
  });

  // 6. Put the blocks back, rewriting their opening tags too.
  for (const block of blocks) {
    const open = rewriteTagOpen(block.tag, block.openAttrs, resolve);
    const openTag = open === null ? `<${block.tag}${block.openAttrs}>` : open;
    const closeTag = block.tag === 'style' ? '</style>' : '</script>';
    html = html.split(block.key).join(`${openTag}${block.inner}${closeTag}`);
  }

  // 7. Inject our <base> + runtime.
  const head = `<base href="${escapeAttr(baseHref || pageUrl)}">${headExtra || ''}`;
  if (/<head\b[^>]*>/i.test(html)) {
    html = html.replace(/<head\b[^>]*>/i, (m) => `${m}${head}`);
  } else if (/<html\b[^>]*>/i.test(html)) {
    html = html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  } else if (/<body\b[^>]*>/i.test(html)) {
    html = html.replace(/<body\b[^>]*>/i, (m) => `${m}${head}`);
  } else {
    html = head + html;
  }

  return html;
}

module.exports = { rewriteHtml, rewriteCss, rewriteSrcset, makeResolver, isProxyPath, decodeEntities };
