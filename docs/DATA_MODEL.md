# Data Model

There is **no relational database**. State is either:

1. **In-memory Python objects** built at boot from the evidence files (`data/`) and cached in module-level registries in `backend/app.py` (`CASES`, `TRACKS`, `STATS`), or
2. **JSON on disk** for auth-only state: `backend/users.json` and `backend/.auth_secret`.

This page documents the on-disk schemas and the in-memory data classes, plus the shapes served over the API.

## On-disk schemas

### `backend/users.json`

Created on first boot by `auth.load_users()`. Each user's `password` is the PBKDF2-HMAC-SHA256 digest (260,000 iterations) of the plaintext; `salt` is a per-user 16-byte hex value.

```json
{
  "users": {
    "admin": {
      "password": "<64-hex pbkdf2 digest>",
      "salt": "<32-hex>",
      "role": "admin",
      "must_change_password": true,
      "created": "2026-07-17T00:00:00Z",
      "created_by": "system"
    },
    "analyst": {
      "password": "<64-hex pbkdf2 digest>",
      "salt": "<32-hex>",
      "role": "analyst",
      "must_change_password": true,
      "created": "2026-07-17T00:00:00Z",
      "created_by": "system"
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `users` | object | Map of `username` → user record |
| `password` | string | 64-char hex PBKDF2 digest |
| `salt` | string | 32-char hex per-user salt |
| `role` | string | `admin` or `analyst` |
| `must_change_password` | boolean | Blocks data access until password is changed (403 `X-Auth-Flow`) |
| `created` | string | ISO-8601 UTC creation timestamp |
| `created_by` | string | Username of creator (`system` for bootstrap) |

**Security:** the file is chmod 0600 and git-ignored. The in-memory cache (`auth._user_cache`) is the source of truth during a process run; writes go through the REST API.

### `backend/.auth_secret`

One line of hex (`secrets.token_hex(32)`) used as the HMAC-SHA256 key for session tokens. Created on first boot, chmod 0600, git-ignored. **Losing it invalidates all outstanding sessions; do not commit it.**

### Session token format

```
<base64url(payload)>.<base64url(hmac_sha256(secret, payload))>
```

```json
{
  "sub": "admin",
  "role": "admin",
  "iat": 1700000000,
  "exp": 1700028800,
  "jti": "1a2b3c4d5e6f"
}
```

TTL is 8 hours. Verified with `hmac.compare_digest` on every request.

## In-memory data classes

Defined in `backend/parsers/cdr.py` (core) and used throughout the engine and API.

### `Ping`
One raw observation (a CDR/LBS/tower-dump record).

| Field | Type | Notes |
|-------|------|-------|
| `ts` | datetime | Event timestamp |
| `lat`, `lon` | float | Tower (CGI) coordinates, **not** the handset, unless `handset_lat/lon` set |
| `cgi` | string | Cell Global Identifier |
| `tower_name` | string | Cell site name (BSNL / FIR47) |
| `call_type` | string | CDR call/sub-call type |
| `operator` | string | Airtel / Vi / Jio / BSNL / Multi |
| `msisdn` | string | Target phone number |
| `source` | string | `cdr` \| `lbs` \| `cell-fusion` |
| `deviation_m` | float? | LBS uncertainty (metres) |
| `handset_lat`, `handset_lon` | float? | Pre-refined handset estimate (parsers already fused sector) |

### `Tower`

| Field | Type | Notes |
|-------|------|-------|
| `cgi` | string | Primary key (per target) |
| `lat`, `lon` | float | BTS location |
| `name` | string | Site name |
| `operator` | string | Operator |
| `hits` | int | Ping count; lat/lon averaged over hits |
| `phone_bearing_deg` | float? | Preferred handset azimuth (internal placement hint, **not serialized**) |

### `Target`
One suspect.

| Field | Type | Notes |
|-------|------|-------|
| `msisdn` | string | Key |
| `operator` | string | |
| `label` | string | Display label |
| `pings` | list[Ping] | Chronologically sorted raw observations |
| `towers` | dict[str, Tower] | Keyed by CGI |

FIR-47 targets add ad-hoc attributes: `_fir_sites` (list), `_fir_name` (string), `_fir_corridor` (bool).

### `Fix` (`backend/engine/__init__.py`)
One refined, Kalman-smoothed position.

| Field | Type | Notes |
|-------|------|-------|
| `ts` | datetime | |
| `lat`, `lon` | float | Smoothed handset position |
| `alt_m` | float | Always 0 (ground-level) |
| `confidence_m` | float | Uncertainty radius |
| `method` | string | `sector` \| `lbs` \| `cell-fusion` \| `multi-tower-fusion` \| `multi-tower-centroid` \| `bilateration` \| `trilateration` |
| `towers_used` | list[str] | CGIs contributing |
| `raw_lat`, `raw_lon` | float | Tower ping location (for UI comparison) |
| `speed_mps`, `heading_deg` | float | From Kalman state (speed capped ~120 km/h) |
| `cgi` | string | Serving cell |
| `gap_m`, `gap_s` | float | Distance / time to previous fix |
| `session_id` | int | Increments on teleport / long-gap splits |
| `is_gap_start` | bool | First fix of a new session |

## API payload shapes

### Target summary

```json
{
  "msisdn": "9714499703",
  "operator": "Airtel",
  "label": "Airtel · Surat",
  "ping_count": 123,
  "tower_count": 8,
  "t_start": "2026-06-01T00:00:00",
  "t_end": "2026-06-01T23:59:59",
  "bbox": { "min_lat": ..., "max_lat": ..., "min_lon": ..., "max_lon": ... },
  "center": { "lat": ..., "lon": ... },
  "case": "erakshak",
  "stats": { "avg_shift_m": ..., "avg_refined_conf_m": ..., "pct_trilateration": ..., "points": ... }
}
```

FIR-47 adds: `name`, `sites` (e.g. `["MORA", "JAHANGIR"]`), `corridor` (bool).

### Reports

`reports.target_report_metrics()` returns:

```json
{
  "type": "target",
  "classification": "RESTRICTED",
  "case_id": "erakshak",
  "msisdn": "9714499703",
  "name": "",
  "operator": "Airtel",
  "label": "Airtel · Surat",
  "coverage": { "start": ..., "end": ..., "duration_h": ..., "ping_count": ..., "tower_count": ... },
  "metrics": { "distance_km": ..., "max_speed_kmh": ..., "avg_speed_kmh": ...,
               "avg_confidence_m": ..., "tri_pct": ..., "sessions": ..., "longest_gap_h": ... },
  "bbox": ..., "center": ...,
  "hourly": [24 ints],
  "by_method": { "trilateration": 10, ... },
  "top_towers": [ { "cgi", "name", "operator", "lat", "lon", "hits", "share" } ],
  "sessions": [ { "id", "start", "end", "points", "distance_km" } ],
  "confidence": { "min": ..., "max": ..., "avg": ... }
}
```

`reports.case_report_metrics()` returns:

```json
{
  "type": "case",
  "classification": "RESTRICTED",
  "case_id": "fir47",
  "subtitle": "NCCRP 222/2024 · Surat Cyber · Mora↔Jahangir",
  "period": { "start": ..., "end": ..., "duration_h": ... },
  "summary": { "targets": 28, "total_pings": ..., "total_towers": ...,
               "total_distance_km": ..., "operators": ["Airtel", ...], "corridor_targets": ... },
  "targets": [ { "msisdn", "name", "operator", "ping_count", "tower_count",
                 "start", "end", "distance_km", "max_speed_kmh", "avg_confidence_m",
                 "tri_pct", "sessions", "sites", "corridor", "label" } ]
}
```

REST handlers append `generated_at` and `generated_by` to report responses.

## Evidence files (`data/`)

| File | Read by | Produces |
|------|---------|----------|
| `9714499703_Airtel.csv` | `parsers/cdr.parse_airtel` | E-Rakshak Airtel target |
| `8980261614_Vi.csv` | `parsers/cdr.parse_vi` | Vi target (coords from address map + LBS) |
| `9877535365_Jio.csv` | `parsers/cdr.parse_jio` | Jio target (opaque cell IDs → LBS coords) |
| `9477523061_BSNL.csv` | `parsers/cdr.parse_bsnl` | BSNL target |
| `Location Data_E-Rakshak.docx` | `parsers/cdr.parse_location_docx` | LBS `Ping`s (lat/long, CGI, deviation) |
| `222_FIR_47/**` (Call Details xlsx, tower-dump csv/xlsx) | `parsers/fir47.load_fir47_targets` | FIR-47 targets (site inference, sector offsets) |
