'use strict';

/**
 * Test origin server: a small site with links, images, css, js, forms,
 * cookies, redirects and XHR — used to verify the proxy rewrites things.
 */

const http = require('node:http');

const PORT = Number(process.env.ORIGIN_PORT || 9099);

const pages = {
  '/': `<!doctype html>
<html><head><meta charset="utf-8"><title>Origin Home</title>
<link rel="stylesheet" href="/style.css">
<style>body { background: url("/img/bg.png"); } .x { background-image:url('img/rel.png'); }</style>
</head>
<body>
<h1>Origin Home</h1>
<a href="/about" id="rel">Relative link</a>
<a href="https://example.org/absolute" id="abs">Absolute link</a>
<a href="https://example.org/other?q=1&amp;x=2" id="absq">Absolute with query</a>
<img src="/img/logo.png" alt="logo">
<img src="img/rel.png" srcset="/img/logo2.png 2x" alt="lazy">
<form action="/login" method="post"><input name="u" value="v"><button>Go</button></form>
<script src="/app.js"></script>
<script>var cfg = { api: "https://example.org/api/v1" };</script>
</body></html>`,

  '/about': `<!doctype html><html><head><title>About</title></head><body>
<h1>About</h1><a href="/">Home</a>
<img src="https://example.org/remote.png">
</body></html>`,

  '/style.css': `body { color: #333; background-image: url(/img/bg.png); } @import "/other.css";`,

  '/other.css': `.o { background: url("https://example.org/remote.png"); }`,

  '/app.js': `fetch("/api/data"); var u = "https://example.org/api/v1";`,

  '/login': `<!doctype html><html><body>Logged in</body></html>`,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Set a cookie
  res.setHeader('Set-Cookie', 'session=abc123; Path=/; HttpOnly');

  if (url.pathname === '/redirect') {
    res.writeHead(302, { Location: '/about' });
    res.end();
    return;
  }

  if (url.pathname === '/echo-cookie') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`cookie=${req.headers.cookie || 'none'}`);
    return;
  }

  if (url.pathname === '/echo-post') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`post=${body}`);
    });
    return;
  }

  if (url.pathname === '/echo-referer') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`referer=${req.headers.referer || 'none'}`);
    return;
  }

  if (url.pathname === '/entity-css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(
      '.a { background: url(&quot;https://example.org/pic.png&quot;); }\n' +
        '.b { background: url("/img/plain.png"); }\n'
    );
    return;
  }

  if (url.pathname === '/refresh') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><meta http-equiv="refresh" content="0; url=/about"></head><body>go</body></html>');
    return;
  }

  if (url.pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cookie: req.headers.cookie || null }));
    return;
  }

  if (url.pathname.startsWith('/img/')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from('89504e470d0a1a0a', 'hex'));
    return;
  }

  if (pages[url.pathname]) {
    const ext = url.pathname.split('.').pop();
    const types = {
      html: 'text/html; charset=utf-8',
      css: 'text/css; charset=utf-8',
      js: 'application/javascript; charset=utf-8',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/html; charset=utf-8' });
    res.end(pages[url.pathname]);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/html' });
  res.end('<html><body>not found</body></html>');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`origin server on http://127.0.0.1:${PORT}`);
});

module.exports = server;
