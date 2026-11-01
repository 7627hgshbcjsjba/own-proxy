'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');
const { URL } = require('node:url');

const config = require('./config');

/* ------------------------------------------------------------------ *
 * IP / host filtering (blocks SSRF into the local network)
 * ------------------------------------------------------------------ */

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24, 192.0.2/24
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Expand a compressed IPv6 address into its 8 hextets. */
function expandIPv6(ip) {
  const addr = ip.toLowerCase().split('%')[0];
  const doubleIdx = addr.indexOf('::');
  const headStr = doubleIdx === -1 ? addr : addr.slice(0, doubleIdx);
  const tailStr = doubleIdx === -1 ? null : addr.slice(doubleIdx + 2);

  const toHextets = (str) => {
    if (!str) return [];
    const out = [];
    for (const part of str.split(':')) {
      if (!part) continue;
      if (part.includes('.')) {
        const v4 = part.split('.').map((n) => parseInt(n, 10));
        if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push(((v4[0] << 8) | v4[1]).toString(16));
        out.push(((v4[2] << 8) | v4[3]).toString(16));
      } else {
        out.push(part);
      }
    }
    return out;
  };

  const head = toHextets(headStr);
  const tail = tailStr === null ? [] : toHextets(tailStr);
  if (head === null || tail === null) return null;

  if (tailStr === null) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array(fill).fill('0'), ...tail];
}

/** Build a dotted-quad IPv4 string from the last two hextets (numbers). */
function hextetsToIPv4(nums) {
  const hi = nums[6] & 0xffff;
  const lo = nums[7] & 0xffff;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateIPv6(ip) {
  const hextets = expandIPv6(ip);
  if (!hextets) return true; // unparsable -> refuse

  const nums = hextets.map((h) => {
    const v = parseInt(h, 16);
    return Number.isInteger(v) ? v : 0;
  });
  const isZeroPrefix = nums.slice(0, 5).every((n) => n === 0);

  // ::ffff:a.b.c.d  (IPv4-mapped)
  if (isZeroPrefix && nums[5] === 0xffff) return isPrivateIPv4(hextetsToIPv4(nums));
  // 64:ff9b::/96 (NAT64)
  if (nums[0] === 0x64 && nums[1] === 0xff9b && nums.slice(2, 6).every((n) => n === 0)) {
    return isPrivateIPv4(hextetsToIPv4(nums));
  }
  // ::1 loopback
  if (isZeroPrefix && nums[5] === 0 && nums[6] === 0 && nums[7] === 1) return true;
  // :: unspecified
  if (nums.every((n) => n === 0)) return true;
  // fc00::/7 unique local
  if ((nums[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link local
  if ((nums[0] & 0xffc0) === 0xfe80) return true;
  // ff00::/8 multicast
  if ((nums[0] & 0xff00) === 0xff00) return true;
  return false;
}

function isBlockedAddress(ip) {
  if (!ip) return true;
  if (ip.includes(':')) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

function isBlockedHostname(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  return false;
}

/**
 * DNS lookup that refuses to hand back private addresses.
 * Wired into http(s).request via the `lookup` option, so the connection
 * can never be redirected to an internal IP (DNS-rebinding safe).
 */
function safeLookup(hostname, options, callback) {
  if (!config.allowPrivateNetworks && isBlockedHostname(hostname)) {
    return callback(new Error(`Blocked hostname: ${hostname}`));
  }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses || !addresses.length) return callback(new Error('DNS lookup returned no addresses'));
    if (!config.allowPrivateNetworks) {
      for (const entry of addresses) {
        if (isBlockedAddress(entry.address)) {
          return callback(new Error(`Blocked address: ${entry.address}`));
        }
      }
    }
    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/* ------------------------------------------------------------------ *
 * Low level request
 * ------------------------------------------------------------------ */

/**
 * Perform a single HTTP(S) request. Redirects are NOT followed here so the
 * caller can rewrite the final URL.
 *
 * @returns {Promise<{res: import('node:http').IncomingMessage, url: string}>}
 */
function rawRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      return reject(new Error(`Invalid URL: ${url}`));
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return reject(new Error(`Unsupported protocol: ${target.protocol}`));
    }
    if (!config.allowPrivateNetworks && isBlockedHostname(target.hostname)) {
      return reject(new Error(`Blocked hostname: ${target.hostname}`));
    }

    const isHttps = target.protocol === 'https:';
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    const isIp = net.isIP(hostname) !== 0;

    const reqOptions = {
      protocol: target.protocol,
      hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: (target.pathname || '/') + (target.search || ''),
      method: options.method || 'GET',
      headers: options.headers || {},
      lookup: safeLookup,
      timeout: config.timeout,
      agent: false,
    };
    if (isHttps) {
      reqOptions.rejectUnauthorized = !config.insecureTLS;
      if (!isIp) reqOptions.servername = hostname;
    }

    const mod = isHttps ? https : http;
    const req = mod.request(reqOptions, (res) => resolve({ res, url: target.href }));

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);

    if (options.body !== undefined && options.body !== null) req.write(options.body);
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * Decompression helpers
 * ------------------------------------------------------------------ */

function decompress(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer);
    if (enc === 'deflate') {
      try {
        return zlib.inflateSync(buffer);
      } catch {
        return zlib.inflateRawSync(buffer);
      }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buffer);
  } catch (err) {
    return buffer; // best effort: serve as-is rather than fail the page
  }
  return buffer;
}

function decodeText(buffer, charset) {
  let encoding = (charset || 'utf-8').toLowerCase().trim();
  if (!encoding || encoding === 'none') encoding = 'utf-8';
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

function charsetFromContentType(contentType) {
  if (!contentType) return null;
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'set-cookie',
  'cookie',
]);

function stripHopByHop(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function readBody(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (limit && size > limit) {
        reject(new Error('Request body too large'));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

module.exports = {
  rawRequest,
  decompress,
  decodeText,
  charsetFromContentType,
  stripHopByHop,
  readBody,
  isBlockedAddress,
  isBlockedHostname,
  safeLookup,
};
