# System Architecture

E-Rakshak Pinpoint is a **single-process FastAPI application** that ingests raw telecom evidence (CDR / LBS / tower-dump files), computes smoothed suspect tracks offline at boot, and serves them through a gated REST + WebSocket API to a browser-based CesiumJS 3D client.

There is **no external database and no message broker** — all state is in-memory, persisted only for the auth store (`backend/users.json`) and the token signing secret (`backend/.auth_secret`).

## Component diagram

```
                        ┌─────────────────────────────────────────────┐
   data/  (CDR CSVs,     │                    Backend                   │
   LBS .docx, tower      │                                             │
   dump .xlsx/.csv)      │  parsers/ ──► Target/Ping/Tower             │
        │                │    cdr.py, fir47.py                          │
        ▼                │         │                                    │
   ┌──────────┐          │         ▼ (in-memory CASES registry)         │
   │  Parsers │          │  engine/ ──► compute_track() ──► TRACKS      │
   └──────────┘          │    Kalman2D + trilaterate                    │
        │                │         │                                    │
        ▼                │         ▼                                    │
   ┌──────────┐          │  reports.py  (pure functions over tracks)    │
   │  Target  │          │                                             │
   └──────────┘          │              app.py (FastAPI)                │
                         │   ┌────────────────────────────────────┐    │
                         │   │ REST  /api/health /auth /admin      │    │
                         │   │       /cases /targets /reports      │    │
                         │   │ WS    /ws/live/{msisdn}             │    │
                         │   │ Static /assets / /login.html ...    │    │
                         │   └───────────────┬────────────────────┘    │
                         └───────────────────┼─────────────────────────┘
                                             │  HTTP + WebSocket (Bearer token)
                                             ▼
                              frontend/ (vanilla JS + CesiumJS)
                              index.html, login.html, report.html
```

## Startup pipeline (module import time)

Everything is computed **once, synchronously, at import** of `backend/app.py:34-62`:

1. `auth.load_users()` — loads `users.json`, seeding bootstrap `admin` / `analyst` accounts on first run.
2. `parsers.cdr.load_all_targets()` — reads the E-Rakshak datasets (`data/*.csv`, `data/Location Data_E-Rakshak.docx`) and builds a `Target` (MSISDN → pings + known towers) for each operator.
3. `parsers.fir47.load_fir47_targets()` — parses the FIR 47 case (Call Details + Airtel tower dumps) and builds up to 28 ranked targets.
4. For every target in every case, `engine.compute_track()` is run and cached in `TRACKS`, with accuracy statistics in `STATS`.

Because this happens at boot, adding or changing datasets requires a restart.

## Location engine (`backend/engine/__init__.py`)

`compute_track(target)` turns a chronologically sorted list of `Ping`s into a list of smoothed `Fix`es:

1. **Urban cluster focus** — keeps the densest city cluster so long-haul roaming outliers don't skew the demo (`_focus_urban_cluster`).
2. **Downsample** — caps at `max_points=900` fixes by striding.
3. **Per-fix measurement fusion**, in priority order:
   - **cell-fusion** (parsers already produced a handset estimate) → optionally blended with a weighted phone centroid when ≥2 towers are in the 120 s window → `multi-tower-fusion`.
   - **LBS** with deviation → refined handset estimate, pushed off mast.
   - **≥2 towers in window** → `_weighted_phone_centroid`, then **trilateration** (≥3) or **bilateration** (2) via least squares (`trilaterate`), rejected if RMS residual > 1200 m.
   - **Single serving cell** → phone placed inside the sector using CGI-derived azimuth and a stable 200–520 m range (`_offset_from_tower`), never on the mast.
4. **Mast-avoidance heuristics** — estimates are pushed ≥140 m from any mast (`_push_away_from_masts`) and (FIR 47) nudged off the Tapi river channel (`_nudge_off_tapi_river`).
5. **Kalman2D** — constant-velocity filter in local ENU metres with innovation gating (teleport-level jumps reset the filter, speed capped at ~120 km/h).
6. **Session splitting** — jumps >10 km (or >24 h with >3 km movement) start a new session id; each gap is flagged `is_gap_start`.

`baseline_single_tower_error()` computes `avg_shift_m` / `avg_refined_conf_m` / `pct_trilateration` stats exposed in every target payload.

## Auth & session model (`backend/auth.py`)

- Passwords: **PBKDF2-HMAC-SHA256**, 260,000 iterations, per-user 16-byte hex salt; stored in `backend/users.json`.
- Session tokens: self-contained `base64url(payload).base64url(hmac_sha256_sig)` blobs, signed with the secret in `backend/.auth_secret`, 8-hour expiry, `jti` nonce.
- Roles: `admin` (full access incl. user management) and `analyst` (view + export). Forced password change is enforced via `require_active` / `require_role` (403 `X-Auth-Flow: change-password`).
- Brute-force lockout: 5 failed logins lock the account for 300 s (in-memory, per-process).
- WebSocket auth uses a `?token=` query param because browsers cannot set headers on WS handshakes.

## Data flow for a live track (WebSocket)

1. Client opens `wss://host/ws/live/{msisdn}?case={case}&token={token}`.
2. Server validates the token; on failure sends `{"type":"error"}` and closes with code 4001.
3. On success the server streams:
   - `{"type":"init", target, stats, towers, total}`,
   - `{"type":"fix", index, total, fix}` every ~0.35 s at playback speed,
   - `{"type":"complete", total}` at the end.
4. Client controls playback by sending JSON commands: `play`, `pause`, `speed {value}`, `seek {index}`, `reset`.

## Frontend

Vanilla JS SPA (no framework, no build step) served by the backend at `/`:

- `login.html` / `js/auth.js` — sign-in, token storage in `localStorage`, `Authorization: Bearer` wrapper.
- `index.html` / `js/app.js` — CesiumJS 3D globe: suspect marker, confidence volume, tower cylinders, trilateration beams, heat corridor, admin user panel, realtime playback.
- `report.html` / `js/report.js` — case / subject intelligence reports in an A4 government layout with CSV / JSON export and print-to-PDF.

## Technology stack

| Layer | Technology |
|-------|------------|
| Backend | Python 3.10+, FastAPI 0.115, Uvicorn 0.34 |
| Computation | NumPy (trilateration, Kalman filtering), python-docx (LBS doc), openpyxl (FIR 47 xlsx) |
| Frontend | Vanilla HTML/CSS/JS, CesiumJS (CDN), no package manager |
| Data | CSV / XLSX / DOCX evidence files → in-memory objects; JSON user store |
| Transport | HTTP REST + WebSocket (both token-gated) |

## Non-goals / known constraints

- Single-process only — the in-memory registry and lockout counters do not survive restart or scale horizontally.
- `users.json` is process-cached (`auth.py:130`); edits via the REST API are written through, direct file edits need a restart (or `auth.load_users()` re-call).
- No persistence of computed tracks; tracks are recomputed at every boot.
- CORS is fully open (`allow_origins=["*"]`) — acceptable for a hackathon, tighten in production (see [DEPLOYMENT.md](./DEPLOYMENT.md)).
