# own-proxy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/7627hgshbcjsjba/own-proxy)

Your own web proxy with your own proxy URL server.

Type a website into the box and it opens at **your** address instead of the
real one:

```
https://example.com/wiki/Proxy      ->   http://your-server:8080/p/example.com/wiki/Proxy
```

Everything you click stays inside the proxy. No browser extension, no
third-party service — it is your server, your URLs.

- **Zero dependencies** — Node.js core modules only.
- **Real proxying** — HTML and CSS are rewritten on the server, so links,
  images, stylesheets, scripts, forms and XHR all stay in the proxy.
- **Cookies work** — each site keeps its own cookies, isolated from the
  others, and `document.cookie` works so logins and CSRF tokens behave.
- **Self-hostable** — run it on a VPS and use your own domain.

---

## Quick start

```bash
cd webproxy
node server.js
```

Then open <http://localhost:8080/>.

Node 18 or newer is required (it is tested on Node 24). There is nothing to
install.

To run it on a different port or interface:

```bash
PORT=9000 HOST=127.0.0.1 node server.js
```

---

## How it works

### The proxy URL format

```
/p/<host>/<original/path?query>
```

* `<host>` — the target host, e.g. `example.com` or `127.0.0.1:3000`.
  The scheme is **not** part of the token: the server tries `https://` first
  and falls back to `http://`, then remembers which one worked.
* `<original/path?query>` — the path and query string, unchanged.

So a page on `https://news.ycombinator.com/item?id=1` is served from:

```
http://your-server:8080/p/news.ycombinator.com/item?id=1
```

### What the server does

1. Fetches the target URL from your server.
2. Rewrites the HTML: every `href`, `src`, `srcset`, `action`, `poster`,
   `formaction`, inline `style`, `<style>` block and `url()` reference is
   rewritten to point back at the proxy.
3. Injects a `<base>` tag plus a small runtime that keeps the browser inside
   the proxy:
   * `fetch()`, `XMLHttpRequest`, `sendBeacon`, `window.open`,
     `history.pushState` and `Location.assign` are redirected through the
     proxy;
   * `src` / `href` / `poster` / `srcset` set from JavaScript are rewritten
     *before* the browser fetches them (so cross-origin scripts are not
     blocked by CORS);
   * a floating toolbar with a URL bar, back / forward / reload / home.
4. Rewrites CSS files the same way, and rewrites `import("...")` /
   `new Worker("...")` inside JavaScript so modules are not loaded twice.
5. Streams images, video, fonts and other binaries straight through.
6. Stores cookies server-side per session **and** forwards them to the
   browser with a rewritten `Path`, so different sites cannot see each
   other's cookies while `document.cookie` still works.

### Why the token is only the host

Sites often refer to themselves with both `http://` and `https://`. If the
scheme were part of the token, the browser would fetch the same script under
two URLs, evaluate it twice and register custom elements twice — which
breaks pages. One token per host avoids that, and it also means links keep
working after the server restarts.

---

## API

| Route | Description |
| --- | --- |
| `GET /` | Home page with the URL box |
| `GET /p/<host>/<path>` | Proxy a site |
| `GET /api/proxy-url?url=<url>` | Returns the proxy URL for any address |
| `GET /health` | JSON status |
| `GET /favicon.ico` | Icon |

```bash
curl "http://localhost:8080/api/proxy-url?url=https://example.com"
# {"url":"https://example.com/","proxy":"/p/example.com/","absolute":"http://localhost:8080/p/example.com/"}
```

---

## Configuration

All settings are environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `ALLOW_PRIVATE_NETWORKS` | off | Allow proxying private/loopback addresses (dev only) |
| `INSECURE_TLS` | off | Skip TLS certificate validation |
| `PROXY_TIMEOUT` | `30000` | Outgoing request timeout in ms |
| `MAX_BUFFER_SIZE` | `67108864` | Largest page buffered for rewriting (bytes) |
| `MAX_UPLOAD_SIZE` | `33554432` | Largest request body forwarded (bytes) |
| `LOG_REQUESTS` | off | Log every proxied request and its status |

### Security

By default the proxy refuses to talk to loopback, private and link-local
addresses (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
`169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`, …). The check happens in a
custom DNS `lookup` hook, so a DNS record that points at a private IP is
rejected too — the proxy cannot be used to reach services inside your
network.

---

## Tests

```bash
node test/run.js
```

The suite boots a small test site and a proxy instance and checks the
rewriting, cookies, redirects, POST bodies, binary passthrough and the
SSRF guards. 28 checks, no network access required.

---

## Putting it online

The repo contains everything needed for the common hosts:

| File | Used by |
| --- | --- |
| `render.yaml` | Render (Blueprint — one click, free tier) |
| `Dockerfile` | Render, Railway, Fly.io, any Docker host |
| `Procfile` | Railway, Heroku-style hosts |
| `fly.toml` | Fly.io |

**Quickest path — Render free tier (no credit card):**

1. Push this repo to GitHub.
2. Go to <https://dashboard.render.com/>, sign up with GitHub, then
   **New → Blueprint** and select your repo.
3. Render reads `render.yaml` and deploys everything for you.

You end up with `https://<your-service>.onrender.com/p/<host>/<path>`.

**Better for a proxy — Oracle Cloud Always Free:** a real VM, always on, no
cold starts and a better IP reputation (far fewer sites block it). It needs a
credit card on signup (verified, never charged) and about 15 minutes of
setup.

Full instructions for Render, Oracle Cloud, Railway and Fly.io — including
the free-tier gotchas (cold starts, bandwidth allowance, the outbound
traffic limit) — are in **[DEPLOY.md](DEPLOY.md)**.

### Abuse protection

A public proxy attracts scrapers, so the server ships with:

* a per-visitor rate limit (`RATE_LIMIT_PER_MINUTE`, default 120/min),
* a cap on simultaneous proxied requests (`MAX_CONCURRENT_REQUESTS`),
* the private-network block described under *Security*,
* a `robots.txt` that discourages crawlers.

Most hosts' acceptable use policies prohibit open proxies. Use it for
yourself and people you know rather than opening it to the world.

---

## Known limits

Some sites will not work perfectly, and no amount of proxying can fix them:

* **Anti-bot systems** (Cloudflare challenges, IMDb, some banks) see requests
  coming from your server's IP address, not the visitor's browser. They may
  show a challenge page or refuse outright.
* **WebSockets** are not proxied.
* **Service workers** cannot be registered on the proxy origin.
* **OAuth / SSO flows** that hard-code the real origin in their callback
  configuration will redirect out of the proxy.
* **Sites that check `location.origin`** in JavaScript will see the proxy's
  origin.

Everything else — the vast majority of the web — works.

---

## Files

```
webproxy/
├── server.js              HTTP server + proxy handler
├── lib/
│   ├── config.js          configuration
│   ├── net.js             safe HTTP client, SSRF guards, decompression
│   ├── cookies.js         server-side cookie jar
│   ├── tokens.js          proxy URL tokens
│   ├── rewrite.js         HTML / CSS rewriter
│   └── client.js          runtime injected into every proxied page
├── public/
│   └── index.html         home page
├── test/
│   ├── origin-server.js   small test site
│   └── run.js             test suite
└── package.json
```

---

Use it for legitimate purposes: privacy, testing, corporate gateways,
research, and anything else you are allowed to access.
