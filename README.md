# E-Rakshak Pinpoint (ERH26_PS_09)

3D multi-tower trilateration & Kalman-filtered suspect tracker for the E-Rakshak Hackathon problem **Telecom Tower Data Multi-Lateration & High-Precision Suspect Pinpointer**.

## Features

- Parses real multi-operator CDR + LBS datasets (Airtel, Vi, Jio, BSNL)
- Multi-tower trilateration with timing-advance style ranging
- 2D constant-velocity Kalman filter for track smoothing
- CesiumJS **3D** globe with live suspect marker, confidence volume, tower cylinders, trilateration beams, and heat corridor
- WebSocket realtime playback of historical tracks
- **Role-based access control** — login, signed session tokens, `admin` / `analyst` roles, forced first-time password change, brute-force lockout
- **Intelligence reports** — case & subject movement reports in a government-standard layout, with CSV / JSON export and print-to-PDF

## Quick start

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8080 --reload
```

Open **http://localhost:8080** — you will be redirected to the secure sign-in page.

## Access control

Bootstrap accounts are created on first boot (credentials are stored as PBKDF2 hashes in `backend/users.json`, which is git-ignored). **Change these on first login.**

| Username | Password (bootstrap) | Role |
|----------|----------------------|------|
| `admin` | `admin123` | Full access incl. user management |
| `analyst` | `analyst123` | View targets + export reports |

- `admin` can create / edit / delete users under **Admin → users** (REST: `/api/admin/users`).
- Session tokens are HMAC-SHA256 signed, expire after 8 hours, and the API is fully gated — including the WebSocket stream.
- 5 failed logins lock an account for 5 minutes.

## Reports

Open **REPORTS** in the top bar (or `/report.html`). Generate a whole-case register or a single-subject movement report, then:

- **CSV / JSON** — export the report or the raw fix track
- **PRINT** — print or save the report as a PDF (A4, government-standard layout)

## Documentation

| Doc | Contents |
|-----|----------|
| [Project structure](docs/PROJECT_STRUCTURE.md) | Full folder tree with annotations |
| [System architecture](docs/ARCHITECTURE.md) | Component diagram, startup pipeline, location engine, auth model |
| [API reference](docs/API.md) | REST + WebSocket endpoints, auth, error codes |
| [Data model](docs/DATA_MODEL.md) | `users.json` / token schemas, in-memory classes, report payloads |
| [Deployment](docs/DEPLOYMENT.md) | Production install: systemd, nginx/Caddy TLS, hardening |

## Dataset

Place operator CSVs and `Location Data_E-Rakshak.docx` under `data/` (already included).

| MSISDN | Operator | Area |
|--------|----------|------|
| 9714499703 | Airtel | Surat |
| 8980261614 | Vi | Rajkot |
| 9877535365 | Jio | Surat |
| 9477523061 | BSNL | Kolkata |
