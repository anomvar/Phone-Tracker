# Project Structure

E-Rakshak Pinpoint is a two-tier web app: a **FastAPI backend** (`backend/`) that parses telecom CDR/LBS data, runs the trilateration + Kalman-filter engine, and serves both the REST/WebSocket API and a **vanilla JS + CesiumJS frontend** (`frontend/`).

```
Phone-Tracking/
├── README.md                       # Overview, quick start, bootstrap accounts
├── run.sh                          # One-shot dev launcher (venv + uvicorn)
├── .gitignore                      # Excludes .venv/, users.json, .auth_secret, ...
│
├── backend/                        # FastAPI application (Python 3.10+)
│   ├── app.py                      # FastAPI app, REST + WebSocket routes, static serving
│   ├── auth.py                     # RBAC: PBKDF2 hashing, HMAC-signed tokens, lockout
│   ├── reports.py                  # Case/target intelligence reports + CSV/JSON export
│   ├── requirements.txt            # Pinned Python dependencies
│   ├── users.json                  # [runtime] user store (git-ignored, created on boot)
│   ├── .auth_secret                # [runtime] token signing secret (git-ignored, 0600)
│   │
│   ├── engine/
│   │   └── __init__.py             # Location engine: Kalman2D, trilaterate, compute_track
│   │
│   └── parsers/
│       ├── __init__.py
│       ├── cdr.py                  # Core data classes + E-Rakshak operator parsers
│       └── fir47.py                # FIR 47 / NCCRP 222-2024 tower-dump + Call Details parser
│
├── frontend/                       # SPA served by the backend (no build step)
│   ├── index.html                  # Main 3D map / dashboard (CesiumJS)
│   ├── login.html                  # Sign-in page
│   ├── report.html                 # Intelligence report generator / printer
│   ├── css/
│   │   ├── app.css                 # Map dashboard styles
│   │   ├── login.css
│   │   └── report.css              # A4 government-standard report layout
│   ├── js/
│   │   ├── app.js                  # Map UI, WebSocket playback, targets, admin panel
│   │   ├── auth.js                 # Login flow, token storage, API fetch wrapper
│   │   └── report.js               # Report building, CSV/JSON export, print
│   └── assets/                     # CesiumJS vendor assets (currently empty)
│
├── data/                           # Input datasets (raw evidence, committed)
│   ├── 9714499703_Airtel.csv       # E-Rakshak case: Airtel CDR (Surat)
│   ├── 8980261614_Vi.csv           # E-Rakshak case: Vi CDR (Rajkot)
│   ├── 9877535365_Jio.csv          # E-Rakshak case: Jio CDR (Surat)
│   ├── 9477523061_BSNL.csv         # E-Rakshak case: BSNL CDR (Kolkata)
│   ├── Location Data_E-Rakshak.docx# LBS snapshots (lat/long, cell IDs, deviations)
│   └── 222_FIR_47/                 # FIR 47 / NCCRP 222-2024 (Surat Cyber) evidence
│       ├── tower dump.docx         # LEA summary document
│       ├── cell id dcb collect/    # Cell-ID dumps + Call Details (Mora ↔ Jahangirpura)
│       └── tower dump/             # LEA per-operator tower dumps (airtel / jio / vi)
│
├── recon/                          # Pentest / recon artifacts (out of scope for runtime)
│   ├── *.md                        # Findings: findings, critical_findings, deep_dive_findings
│   └── *.txt                       # Endpoint / subdomain / nuclei scanner output
│
└── docs/                           # Project documentation
    ├── PROJECT_STRUCTURE.md        # This file
    ├── ARCHITECTURE.md             # System architecture & processing pipeline
    ├── API.md                      # REST + WebSocket API reference
    ├── DATA_MODEL.md               # Data model, users.json schema, report payloads
    └── DEPLOYMENT.md               # Production deployment guidance
```

## Runtime-only files

The following do not exist on a fresh clone; they are created on first boot and are git-ignored:

| Path | Purpose |
|------|---------|
| `backend/users.json` | User store (PBKDF2 hashes, roles, lockout counters). Seeded with bootstrap `admin` / `analyst`. |
| `backend/.auth_secret` | 64-char hex HMAC signing secret, chmod 0600. Used to sign session tokens. |

See [DATA_MODEL.md](./DATA_MODEL.md) for the exact schemas.
