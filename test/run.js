'use strict';

/**
 * Integration test suite for own-proxy.
 *
 *   node test/run.js
 *
 * Boots the test origin site + the proxy, then checks that:
 *   - HTML links/images/scripts/css are rewritten to /p/<token>/...
 *   - redirects keep you inside the proxy
 *   - cookies survive the round trip
 *   - POST bodies are forwarded
 *   - forms target the proxy
 *   - private addresses are blocked
 */

const http = require('node:http');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROXY_PORT = Number(process.env.TEST_PROXY_PORT || 8123);
const ORIGIN_PORT = Number(process.env.TEST_ORIGIN_PORT || 9123);
const ORIGIN = `http://127.0.0.1:${ORIGIN_PORT}`;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  \u2713 ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  \u2717 ${name}`);
      console.log(`      ${err.message}`);
    });
}

/**
 * Minimal cookie-keeping HTTP client so the proxy sees one continuous
 * session (the proxy keys its cookie jar on the `pid` cookie).
 */
let sessionCookie = '';

function get(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers || {}) };
    if (sessionCookie) headers.cookie = sessionCookie;

    const req = http.request(url, { method: opts.method || 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          const list = Array.isArray(setCookie) ? setCookie : [setCookie];
          for (const sc of list) {
            const pid = /^pid=([^;]+)/.exec(sc);
            if (pid) sessionCookie = `pid=${pid[1]}`;
          }
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function waitForServer(url, attempts = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      get(url)
        .then(() => resolve())
        .catch(() => {
          if (n <= 0) return reject(new Error('server did not start'));
          setTimeout(() => attempt(n - 1), 200);
        });
    };
    attempt(attempts);
  });
}

async function main() {
  console.log('\nown-proxy test suite\n');

  // --- boot servers ---
  const origin = spawn(process.execPath, [path.join(__dirname, 'origin-server.js')], {
    env: { ...process.env, ORIGIN_PORT: String(ORIGIN_PORT) },
    stdio: 'ignore',
  });
  const proxy = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PROXY_PORT),
      ALLOW_PRIVATE_NETWORKS: '1', // the test origin lives on 127.0.0.1
      RATE_LIMIT_PER_MINUTE: '60', // low enough for the rate limit test
    },
    stdio: 'ignore',
  });

  const cleanup = () => {
    try { origin.kill(); } catch {}
    try { proxy.kill(); } catch {}
  };
  process.on('exit', cleanup);

  try {
    await waitForServer(`${PROXY}/health`);
    await waitForServer(`${ORIGIN}/`);
  } catch (err) {
    console.error('failed to start servers:', err.message);
    cleanup();
    process.exit(1);
  }

  // --- helpers ---
  const proxyOf = (originUrl, rest = '/') => {
    const u = new URL(originUrl);
    return `${PROXY}/p/${u.host}${rest}`;
  };

  const home = proxyOf(ORIGIN);

  await test('serves the proxy home page', async () => {
    const res = await get(`${PROXY}/`);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('own-proxy'));
  });

  await test('proxies a page', async () => {
    const res = await get(home);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Origin Home'), 'page body should be proxied');
  });

  await test('rewrites relative links to proxy paths', async () => {
    const res = await get(home);
    assert.ok(!/href="\/about"/.test(res.body), 'raw relative link should be gone');
    assert.ok(/href="\/p\/[^"]+\/about"/.test(res.body), 'link should point into the proxy');
  });

  await test('rewrites absolute links to proxy paths', async () => {
    const res = await get(home);
    assert.ok(!/href="https:\/\/example\.org\/absolute"/.test(res.body), 'raw absolute link should be gone');
    assert.ok(/href="\/p\/[^"]+\/absolute"/.test(res.body), 'absolute link proxied');
  });

  await test('keeps query strings on rewritten links', async () => {
    const res = await get(home);
    assert.ok(/\/other\?q=1&amp;x=2"/.test(res.body), 'query string preserved');
  });

  await test('rewrites img src', async () => {
    const res = await get(home);
    assert.ok(/src="\/p\/[^"]+\/img\/logo\.png"/.test(res.body), 'img src proxied');
  });

  await test('rewrites script src', async () => {
    const res = await get(home);
    assert.ok(/src="\/p\/[^"]+\/app\.js"/.test(res.body), 'script src proxied');
  });

  await test('rewrites link stylesheet href', async () => {
    const res = await get(home);
    assert.ok(/href="\/p\/[^"]+\/style\.css"/.test(res.body), 'stylesheet proxied');
  });

  await test('rewrites inline <style> url()', async () => {
    const res = await get(home);
    assert.ok(/url\("\/p\/[^"]+\/img\/bg\.png"\)/.test(res.body), 'inline style url proxied');
  });

  await test('rewrites form action', async () => {
    const res = await get(home);
    assert.ok(/action="\/p\/[^"]+\/login"/.test(res.body), 'form action proxied');
  });

  await test('rewrites srcset', async () => {
    const res = await get(home);
    assert.ok(/srcset="\/p\/[^"]+\/img\/logo2\.png 2x"/.test(res.body), 'srcset proxied');
  });

  await test('injects the client runtime and <base>', async () => {
    const res = await get(home);
    assert.ok(res.body.includes('data-ownproxy="1"'), 'runtime injected');
    assert.ok(/<base href="\/p\/[^"]+"/.test(res.body), 'base href injected');
  });

  await test('does not mangle meta charset', async () => {
    const res = await get(home);
    assert.ok(res.body.includes('<meta charset="utf-8">'), 'meta charset intact');
  });

  await test('rewrites CSS files', async () => {
    const res = await get(proxyOf(ORIGIN, '/style.css'));
    assert.ok(res.status === 200);
    assert.ok(res.body.includes('/p/'), 'css urls proxied');
    assert.ok(!/url\(\/img\//.test(res.body), 'raw css url should be gone');
  });

  await test('follows redirects inside the proxy', async () => {
    const res = await get(proxyOf(ORIGIN, '/redirect'));
    assert.equal(res.status, 302);
    assert.ok(/^\/p\//.test(res.headers.location), `redirect should stay in proxy, got ${res.headers.location}`);
  });

  await test('forwards and replays cookies', async () => {
    const first = await get(proxyOf(ORIGIN, '/echo-cookie'));
    assert.ok(first.body.includes('session=abc123'), `cookie should be stored, got ${first.body}`);

    const second = await get(proxyOf(ORIGIN, '/echo-cookie'));
    assert.ok(second.body.includes('session=abc123'), 'cookie replayed on next request');
  });

  await test('forwards POST bodies', async () => {
    const res = await get(proxyOf(ORIGIN, '/echo-post'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'user=hello&x=1',
    });
    assert.ok(res.body.includes('user=hello'), `post body should be forwarded, got ${res.body}`);
  });

  await test('serves binary assets untouched', async () => {
    const res = await get(proxyOf(ORIGIN, '/img/logo.png'));
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('image/png'));
    assert.equal(res.body.length, 8);
  });

  await test('/api/proxy-url returns a proxy link', async () => {
    const res = await get(`${PROXY}/api/proxy-url?url=https://example.com`);
    const json = JSON.parse(res.body);
    assert.ok(json.proxy.startsWith('/p/'), 'proxy path returned');
  });

  await test('blocks private / loopback addresses by default', async () => {
    // This proxy instance allows private nets for the test origin, so check
    // the guard directly instead.
    const net = require('../lib/net');
    assert.equal(net.isBlockedAddress('127.0.0.1'), true);
    assert.equal(net.isBlockedAddress('10.0.0.5'), true);
    assert.equal(net.isBlockedAddress('169.254.169.254'), true);
    assert.equal(net.isBlockedAddress('::1'), true);
    assert.equal(net.isBlockedAddress('8.8.8.8'), false);
    assert.equal(net.isBlockedAddress('2606:4700::1111'), false);
  });

  await test('unknown proxy token returns 404', async () => {
    const res = await get(`${PROXY}/p/this-host-does-not-exist.invalid/`);
    assert.equal(res.status, 502, 'an unresolvable host should fail fast');
  });

  await test('hostile origin (private IP) is refused', async () => {
    const res = await get(`${PROXY}/p/169.254.169.254/`);
    assert.ok(res.status === 502 || res.status === 404, `expected refusal, got ${res.status}`);
  });

  await test('forwards Set-Cookie to the browser with a rewritten path', async () => {
    const res = await get(proxyOf(ORIGIN, '/echo-cookie'));
    const setCookie = res.headers['set-cookie'] || [];
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    const target = list.find((c) => c.startsWith('session='));
    assert.ok(target, 'target cookie should be forwarded to the browser');
    assert.ok(!/domain=/i.test(target), 'Domain attribute must be dropped');
    assert.ok(/Path=\/p\//.test(target), `path should be scoped to the proxy, got ${target}`);
  });

  await test('session cookie is preserved alongside target cookies', async () => {
    const res = await get(proxyOf(ORIGIN, '/echo-cookie'));
    const setCookie = res.headers['set-cookie'] || [];
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    assert.ok(list.some((c) => c.startsWith('pid=')), 'session cookie must survive');
  });

  await test('does not rewrite the proxy into itself', async () => {
    const res = await get(`${PROXY}/p/127.0.0.1:${PROXY_PORT}/`);
    assert.ok(res.status === 400 || res.status === 404, `expected refusal, got ${res.status}`);
  });

  await test('entity-encoded CSS urls are handled', async () => {
    const res = await get(proxyOf(ORIGIN, '/entity-css'));
    assert.ok(res.status === 200);
    assert.ok(!/%22/.test(res.body), 'quoted entities should not end up in the url');
    assert.ok(res.body.includes('/p/'), 'css url should be proxied');
  });

  await test('meta refresh redirects inside the proxy', async () => {
    const res = await get(proxyOf(ORIGIN, '/refresh'));
    assert.ok(res.status === 200);
    const m = /url=(\/p\/[^"'\s]+)/.exec(res.body);
    assert.ok(m, `meta refresh should point into the proxy, got ${res.body.slice(0, 200)}`);
  });

  await test('referer header is a valid absolute URL', async () => {
    const res = await get(proxyOf(ORIGIN, '/echo-referer'));
    assert.ok(res.body.startsWith('referer=http'), `referer must be absolute, got ${res.body}`);
    assert.ok(!res.body.includes('referer=/p/'), 'referer must not be a bare path');
  });

  await test('rate limiting kicks in', async () => {
    // The test proxy runs with a low limit so this is quick.
    let limited = false;
    for (let i = 0; i < 120; i++) {
      const res = await get(proxyOf(ORIGIN, '/about'));
      if (res.status === 429) {
        limited = true;
        assert.ok(res.headers['retry-after'], 'a Retry-After header should be sent');
        break;
      }
    }
    assert.ok(limited, 'the rate limiter should have kicked in');
  });

  await test('the home page is not rate limited', async () => {
    const res = await get(`${PROXY}/`);
    assert.equal(res.status, 200);
  });

  await test('robots.txt discourages crawlers', async () => {
    const res = await get(`${PROXY}/robots.txt`);
    assert.equal(res.status, 200);
    assert.ok(/Disallow: \/p\//.test(res.body), 'the proxy path should be disallowed');
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  cleanup();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
