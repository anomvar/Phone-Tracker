# Deployment

## Overview

The app is a single FastAPI/Uvicorn process that also serves the static frontend. There is no build step, no database migration, and no external service to provision — deployment is: **get the code + data in place, install Python deps, run Uvicorn behind a reverse proxy with TLS.**

> The repository is a hackathon/pentest deliverable. The notes below target a **single trusted host**. Treat `data/` as sensitive evidence; `backend/users.json` and `backend/.auth_secret` as credentials.

## Requirements

- Linux (systemd assumed below), Python **3.10+**
- Reverse proxy (nginx or Caddy) for TLS + WebSocket proxying
- A trusted location for `data/` (included in the repo)

## 1. Install

```bash
git clone <repo> /opt/erakshak
cd /opt/erakshak/backend
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
```

Verify the app boots and precomputes tracks:

```bash
cd /opt/erakshak
./run.sh   # or:
# cd backend && .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8080
```

First boot creates `backend/users.json` (bootstrap `admin/admin123`, `analyst/analyst123`) and `backend/.auth_secret`. **Log in and change the bootstrap passwords immediately.**

## 2. Run under systemd

`/etc/systemd/system/erakshak.service`:

```ini
[Unit]
Description=E-Rakshak Pinpoint
After=network.target

[Service]
Type=simple
User=erakshak
Group=erakshak
WorkingDirectory=/opt/erakshak/backend
ExecStart=/opt/erakshak/backend/.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8080
Restart=on-failure
RestartSec=3
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/erakshak/backend
# secrets written on first boot must be writable

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now erakshak
journalctl -u erakshak -f
```

## 3. Reverse proxy + TLS

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name erakshak.example.org;

    ssl_certificate     /etc/letsencrypt/live/erakshak.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/erakshak.example.org/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

TLS certificate (Let's Encrypt):

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d erakshak.example.org
```

### Caddy (simpler)

```
erakshak.example.org {
    reverse_proxy /ws/* 127.0.0.1:8080
    reverse_proxy 127.0.0.1:8080
}
```

Caddy obtains and renews certificates automatically.

## 4. Hardening checklist

| Area | Action |
|------|--------|
| Bootstrap creds | Change `admin` / `analyst` passwords on first login (forced by the app). |
| Secrets | `backend/users.json` + `backend/.auth_secret` are 0600 and git-ignored — do not commit, do not back up to unencrypted storage. |
| CORS | `backend/app.py:26` sets `allow_origins=["*"]`. Restrict to your origin(s) before internet exposure. |
| Network | Bind Uvicorn to `127.0.0.1` only; never expose it directly (no TLS, no auth on the WebSocket handshake path beyond the token). |
| Evidence | `data/` contains real CDR evidence — restrict filesystem permissions and access. |
| Accounts | Limit who gets `admin`; prefer `analyst` for read/export. Use the REST API (`/api/admin/users`), not hand-editing `users.json` (the process caches users; direct edits need a restart). |
| Backups | Back up `data/`, `backend/users.json`, `backend/.auth_secret`, and this service file. Recomputing tracks is automatic on boot. |

## 5. Operational notes

- **Restart to pick up new data.** Tracks are precomputed once at import time (`backend/app.py:56-62`); adding/changing files under `data/` requires a service restart.
- **Single process.** Lockout counters, the user cache, and the track registry are in-memory. Restart clears failed-login state and re-reads `users.json`.
- **Losing `.auth_secret`** invalidates all sessions (users just log in again) — but if it is replaced, existing `users.json` records remain valid.
- **WebSocket via HTTP/2 + nginx:** if you enable `http2` and experience WS failures, ensure the `location /ws/` block uses the upgrade headers above (it does in the example). Caddy handles this automatically.
- **Resource use:** boot cost is dominated by parser + engine work (up to ~30 targets × ≤900 fixes). A single VPS is ample. `uvicorn` worker count should stay at **1** unless you move the track registry to shared state — multi-worker mode would recompute per worker and duplicate in-memory state.
