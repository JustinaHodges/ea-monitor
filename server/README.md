# 四季常春监控公益版 — Node.js server (VPS)

Production server for Linux VPS. Reuses the same API and business logic as the Cloudflare Worker in `../src/`, with SQLite via `better-sqlite3` instead of D1.

## Quick start

```bash
cd server
cp .env.example .env
# Edit .env — set ADMIN_TOKEN (used as admin login password)

npm install
npm start
```

Open `http://localhost:8787`. Log in with your `ADMIN_TOKEN`.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8787` | HTTP listen port |
| `ADMIN_TOKEN` | *(required)* | Admin login password + cookie value |
| `NOTIFY_WEBHOOK` | — | Default webhook URL (overridable in UI) |
| `OFFLINE_AFTER_SECONDS` | `180` | Offline detection threshold |
| `DATA_DIR` | `./data` | Directory for `ea-monitor.db` |
| `LICENSE_ENFORCE` | `0` | Keep `0` for open-source self-host (no activation code) |

See `../docs/宝塔安装.md` for BT Panel + Nginx steps.
## Deploy on Linux (systemd + nginx)

1. Clone/copy the repo to the VPS (needs `public/`, `src/`, `schema.sql`, and `server/`).
2. Install Node.js 20+ and build tools for `better-sqlite3` (`build-essential` on Debian/Ubuntu).
3. In `server/`: `npm ci`, copy `.env.example` → `.env`, set secrets.
4. Install systemd unit:

   ```bash
   sudo cp deploy/ea-monitor.service /etc/systemd/system/
   # Edit WorkingDirectory and User in the unit file
   sudo systemctl daemon-reload
   sudo systemctl enable --now ea-monitor
   ```

5. Install nginx site:

   ```bash
   sudo cp deploy/nginx-520.16881488.xyz.conf /etc/nginx/sites-available/ea-monitor
   sudo ln -s /etc/nginx/sites-available/ea-monitor /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

6. Point DNS for your domain to the VPS and use HTTPS (certbot recommended). Nginx sets `X-Forwarded-Proto` so admin cookies get `Secure` behind TLS.

## EA clients

MQL EAs in `../mql/` use HMAC signing unchanged. Set the EA **API base URL** to your VPS domain, e.g. `https://520.16881488.xyz` (no trailing slash).

## Development

```bash
npm run dev   # tsx watch — auto-reload on file changes
```
