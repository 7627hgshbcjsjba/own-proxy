# Deploying own-proxy for free

The app is a plain Node.js HTTP server, so it runs on any host that can run
Node 18+ and lets it make outbound HTTP requests.

Everything needed is already in the repo:

| File | Used by |
| --- | --- |
| `render.yaml` | Render (Blueprint, one click) |
| `Dockerfile` | Render, Railway, Fly.io, any Docker host |
| `Procfile` | Railway, Heroku-style hosts |
| `fly.toml` | Fly.io |

---

## Option 1 — Render (free tier, recommended)

**Cost:** $0. 512 MB RAM, 0.1 CPU, 5 GB bandwidth/month included.
**No credit card required.**

The repository is already published at
<https://github.com/7627hgshbcjsjba/own-proxy>, so the fastest route is the
button in the README, or:

### Steps

1. **Push the code to GitHub** (if you have not already):

   ```bash
   git remote add origin https://github.com/7627hgshbcjsjba/own-proxy.git
   git push -u origin main
   ```

2. **Create the service**
   * Go to <https://dashboard.render.com/> and sign up (GitHub login works).
   * Click **New → Blueprint**.
   * Point it at the `7627hgshbcjsjba/own-proxy` repository.
   * Render reads `render.yaml` and fills everything in:
     * Runtime `node`, Plan `free`, Region `oregon`
     * Build `npm install --omit=dev`, Start `node server.js`
     * Health check `/health`
   * Click **Apply**.

3. Wait for the build (about a minute), then open
   `https://own-proxy.onrender.com`.

   The proxy URL format is then:

   ```
   https://own-proxy.onrender.com/p/<host>/<path>
   ```

### Free-tier behaviour to expect

* **Cold starts.** A free service sleeps after 15 minutes without traffic and
  takes roughly a minute to wake up. The first request after a quiet period
  shows a loading page. A scheduled ping (a free cron job hitting `/health`
  every 10 minutes) keeps it awake — Render's own docs allow this, but check
  their terms.
* **Bandwidth.** 5 GB/month included, then $0.15/GB. Proxying a page
  downloads it *and* uploads it, so it costs about twice the page size.
  Without a payment method Render suspends the service once the allowance is
  used up.
* **Outbound traffic.** Render's docs say they may suspend a *free* service
  that "initiates an uncommonly high volume of traffic over the public
  internet" — which is exactly what a proxy does. Personal use is fine;
  heavy or commercial use is not. If that happens, move to a paid plan or to
  the Oracle Cloud option below.
* **Ephemeral filesystem.** Sessions and the rate-limiter state reset on
  every restart. Tokens are derived from the host, so links keep working.

---

## Option 2 — Oracle Cloud Always Free (best for a proxy)

**Cost:** $0 forever. A real VM with a public IPv4 address — always on, no
cold starts, and a much better IP reputation, so far fewer sites block it.

**Needs a credit card** (it is verified but never charged) and about 15
minutes of setup.

1. Sign up at <https://www.oracle.com/cloud/free/> and pick
   **Always Free** → `VM.Standard.A1.Flex` (4 ARM cores, 24 GB RAM) or
   `VM.Standard.E2.1.Micro` (1 GB RAM).
2. Create the instance with Ubuntu 22.04, add an SSH key, and open ports
   80 and 443 in the security list.
3. SSH in and install Node:

   ```bash
   sudo apt-get update && sudo apt-get install -y nodejs npm
   # or use nodesource for Node 22
   ```

4. Copy the project up and run it:

   ```bash
   git clone <your-repo> ~/own-proxy && cd ~/own-proxy
   node server.js
   ```

5. Put it behind Caddy for HTTPS (free, automatic certificates):

   ```
   # /etc/caddy/Caddyfile
   proxy.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

   ```bash
   sudo systemctl enable --now caddy
   ```

6. Keep it running:

   ```bash
   sudo tee /etc/systemd/system/own-proxy.service > /dev/null <<'EOF'
   [Unit]
   Description=own-proxy
   After=network.target

   [Service]
   Type=simple
   User=ubuntu
   WorkingDirectory=/home/ubuntu/own-proxy
   ExecStart=/usr/bin/node server.js
   Restart=always
   Environment=PORT=8080

   [Install]
   WantedBy=multi-user.target
   EOF

   sudo systemctl enable --now own-proxy
   ```

---

## Option 3 — Railway (free trial)

```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

$5 of credit for 30 days, no card. After that the free plan only includes
$1/month — not enough to keep a Node server running, so expect it to pause.
Better as a temporary preview than as a permanent home.

---

## Option 4 — Fly.io

```bash
npm i -g flyctl
fly auth login
fly launch --no-deploy --copy-config
fly deploy
```

`fly.toml` is already configured with an `/health` check and
`auto_stop_machines`, so it scales to zero when idle. Fly's free allowance
has changed several times — check <https://fly.io/docs/about/pricing/> for
the current terms.

---

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | Set automatically by most hosts |
| `HOST` | `0.0.0.0` | Keep as is |
| `RATE_LIMIT_PER_MINUTE` | `120` | Requests per minute per visitor |
| `MAX_CONCURRENT_REQUESTS` | `64` | Simultaneous proxied requests |
| `ALLOW_PRIVATE_NETWORKS` | `0` | Leave off — it would expose your LAN |
| `TRUST_PROXY` | `1` | Honour `X-Forwarded-*` from the hosting proxy |
| `LOG_REQUESTS` | `0` | Set to `1` to log every proxied request |

---

## After deploying

1. Open your proxy's home page and try a site.
2. Check `https://your-proxy/health` — it should return JSON.
3. Consider adding a custom domain (Render supports two free ones).

**A word of caution:** a public proxy on a shared free host attracts scrapers
and abuse. The rate limiter, the `robots.txt` and the private-network block
are already in place, but keep an eye on the usage. Most hosts' acceptable
use policies prohibit open proxies, so use it for yourself and people you
know rather than opening it to the world.
