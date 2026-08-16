"""E-Rakshak Pinpoint — FastAPI backend with realtime WebSocket playback."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from parsers.cdr import load_all_targets
from parsers.fir47 import load_fir47_targets, fir47_summary
from engine import compute_track, baseline_single_tower_error
import auth
import reports

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"

app = FastAPI(title="E-Rakshak Pinpoint", version="1.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

auth.load_users()

# Case registries: case_id → {msisdn → Target}
CASE_META = {
    "erakshak": {
        "id": "erakshak",
        "label": "E-Rakshak",
        "subtitle": "Hackathon CDR · Multi-operator",
    },
    "fir47": {
        "id": "fir47",
        "label": "FIR 47",
        "subtitle": "NCCRP 222/2024 · Surat Cyber · Mora↔Jahangir",
    },
}
CASES: dict[str, dict] = {
    "erakshak": load_all_targets(),
    "fir47": load_fir47_targets(),
}
TRACKS: dict[str, dict[str, list]] = {}
STATS: dict[str, dict[str, dict]] = {}

for case_id, targets in CASES.items():
    TRACKS[case_id] = {}
    STATS[case_id] = {}
    for msisdn, target in targets.items():
        fixes = compute_track(target)
        TRACKS[case_id][msisdn] = fixes
        STATS[case_id][msisdn] = baseline_single_tower_error(fixes)


def _resolve(case: str, msisdn: str):
    case = (case or "erakshak").lower()
    targets = CASES.get(case) or {}
    return case, targets.get(msisdn), TRACKS.get(case, {}).get(msisdn), STATS.get(case, {}).get(msisdn)


def _target_payload(case: str, msisdn: str, target) -> dict:
    if case == "fir47":
        s = fir47_summary(target)
    else:
        s = target.to_summary()
        s["case"] = case
    s["stats"] = STATS.get(case, {}).get(msisdn, {})
    return s


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "auth": "required",
        "cases": {cid: len(t) for cid, t in CASES.items()},
    }


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


@app.post("/api/auth/login")
def login(body: dict):
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    if not username or not password:
        raise HTTPException(400, "username and password required")
    user = auth.authenticate(username, password)
    if not user:
        remaining = auth.lockout_seconds_left(username)
        detail = "Invalid credentials"
        if remaining:
            detail = f"Account temporarily locked · retry in {remaining}s"
        raise HTTPException(401, detail=detail)
    return {
        "token": auth.create_token(username, user["role"]),
        "username": username,
        "role": user["role"],
        "must_change_password": bool(user.get("must_change_password")),
    }


@app.get("/api/auth/me")
def me(user: dict = Depends(auth.current_user)):
    rec = user["record"]
    return {
        "username": user["username"],
        "role": user["role"],
        "must_change_password": bool(rec.get("must_change_password")),
        "created": rec.get("created"),
    }


@app.post("/api/auth/change-password")
def change_password(body: dict, user: dict = Depends(auth.current_user)):
    current = str(body.get("current_password") or "")
    new_password = str(body.get("new_password") or "")
    rec = user["record"]
    if not auth.verify_password(current, rec["salt"], rec["password"]):
        raise HTTPException(400, "Current password is incorrect")
    if len(new_password) < 10:
        raise HTTPException(400, "New password must be at least 10 characters")
    if not any(c.isdigit() for c in new_password) or not any(c.isalpha() for c in new_password):
        raise HTTPException(400, "New password must contain letters and digits")
    hex_hash, salt = auth.hash_password(new_password)
    auth.set_user_field(
        user["username"],
        password=hex_hash,
        salt=salt,
        must_change_password=False,
        updated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
    auth.clear_failures(user["username"])
    return {"ok": True}


# ---------------------------------------------------------------------------
# Admin — user management
# ---------------------------------------------------------------------------


@app.get("/api/admin/users")
def list_users(user: dict = Depends(auth.require_role("admin"))):
    users = auth.load_users()
    return [
        {
            "username": u,
            "role": info.get("role"),
            "must_change_password": bool(info.get("must_change_password")),
            "created": info.get("created"),
            "created_by": info.get("created_by"),
        }
        for u, info in sorted(users.items())
    ]


@app.post("/api/admin/users")
def create_user(body: dict, user: dict = Depends(auth.require_role("admin"))):
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    role = str(body.get("role") or "analyst")
    if not username or not password:
        raise HTTPException(400, "username and password required")
    if role not in auth.ROLES:
        raise HTTPException(400, f"role must be one of {auth.ROLES}")
    if len(password) < 10 or not (any(c.isdigit() for c in password) and any(c.isalpha() for c in password)):
        raise HTTPException(400, "password must be ≥10 chars with letters and digits")
    if auth.get_user(username):
        raise HTTPException(409, "user already exists")
    auth.add_user(username, password, role, created_by=user["username"])
    return {"ok": True, "username": username, "role": role}


@app.patch("/api/admin/users/{username}")
def update_user(username: str, body: dict, user: dict = Depends(auth.require_role("admin"))):
    target = auth.get_user(username)
    if not target:
        raise HTTPException(404, "user not found")
    if "role" in body:
        role = str(body["role"])
        if role not in auth.ROLES:
            raise HTTPException(400, f"role must be one of {auth.ROLES}")
        auth.set_user_field(username, role=role)
    if body.get("password"):
        password = str(body["password"])
        if len(password) < 10 or not (any(c.isdigit() for c in password) and any(c.isalpha() for c in password)):
            raise HTTPException(400, "password must be ≥10 chars with letters and digits")
        hex_hash, salt = auth.hash_password(password)
        auth.set_user_field(username, password=hex_hash, salt=salt, must_change_password=True)
    return {"ok": True}


@app.delete("/api/admin/users/{username}")
def delete_user(username: str, user: dict = Depends(auth.require_role("admin"))):
    if username == user["username"]:
        raise HTTPException(400, "cannot delete your own account")
    if not auth.get_user(username):
        raise HTTPException(404, "user not found")
    users = auth.load_users()
    users.pop(username, None)
    auth.save_users()
    auth.clear_failures(username)
    return {"ok": True}


@app.get("/api/cases")
def list_cases(user: dict = Depends(auth.require_active)):
    return [
        {
            **CASE_META["erakshak"],
            "targets": len(CASES.get("erakshak", {})),
        },
        {
            **CASE_META["fir47"],
            "targets": len(CASES.get("fir47", {})),
        },
    ]


@app.get("/api/targets")
def list_targets(case: str = Query("erakshak"), user: dict = Depends(auth.require_active)):
    case = case.lower()
    targets = CASES.get(case, {})
    out = []
    for msisdn, t in targets.items():
        out.append(_target_payload(case, msisdn, t))
    # Corridor movers first for FIR 47
    if case == "fir47":
        out.sort(key=lambda x: (not x.get("corridor"), -(x.get("ping_count") or 0)))
    return out


@app.get("/api/targets/{msisdn}")
def get_target(
    msisdn: str,
    case: str = Query("erakshak"),
    user: dict = Depends(auth.require_active),
):
    case, t, track, stats = _resolve(case, msisdn)
    if not t:
        return {"error": "not found"}
    payload = _target_payload(case, msisdn, t)
    payload["towers"] = [tw.to_dict() for tw in t.towers.values()]
    payload["track"] = [f.to_dict() for f in (track or [])]
    return payload


@app.get("/api/targets/{msisdn}/towers")
def get_towers(
    msisdn: str,
    case: str = Query("erakshak"),
    user: dict = Depends(auth.require_active),
):
    case, t, _, _ = _resolve(case, msisdn)
    if not t:
        return []
    return [tw.to_dict() for tw in t.towers.values()]


@app.get("/api/targets/{msisdn}/track")
def get_track(
    msisdn: str,
    case: str = Query("erakshak"),
    user: dict = Depends(auth.require_active),
):
    _, _, track, _ = _resolve(case, msisdn)
    return [f.to_dict() for f in (track or [])]


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------


@app.get("/api/reports/case/{case_id}")
def case_report(
    case_id: str,
    user: dict = Depends(auth.require_active),
):
    case_id = case_id.lower()
    targets = CASES.get(case_id)
    if not targets:
        raise HTTPException(404, "unknown case")
    r = reports.case_report_metrics(
        case_id, targets, TRACKS.get(case_id, {}), STATS.get(case_id, {}),
        CASE_META.get(case_id, {}).get("subtitle", ""),
    )
    r["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    r["generated_by"] = user["username"]
    return r


@app.get("/api/reports/target/{msisdn}")
def target_report(
    msisdn: str,
    case: str = Query("erakshak"),
    user: dict = Depends(auth.require_active),
):
    case_id, t, track, stats = _resolve(case, msisdn)
    if not t:
        raise HTTPException(404, "unknown target")
    r = reports.target_report_metrics(case_id, msisdn, t, track, stats)
    r["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    r["generated_by"] = user["username"]
    return r


@app.get("/api/reports/export/target/{msisdn}.csv")
def export_target_csv(
    msisdn: str,
    case: str = Query("erakshak"),
    user: dict = Depends(auth.require_active),
):
    _, _, track, _ = _resolve(case, msisdn)
    if not track:
        raise HTTPException(404, "unknown target")
    content = reports.track_csv(track)
    return Response(
        content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{msisdn}_track.csv"'},
    )


@app.get("/api/reports/export/target/{msisdn}.json")
def export_target_json(
    msisdn: str,
    case: str = Query("erakshak"),
    user: dict = Depends(auth.require_active),
):
    case_id, t, track, stats = _resolve(case, msisdn)
    if not t:
        raise HTTPException(404, "unknown target")
    payload = _target_payload(case_id, msisdn, t)
    payload["towers"] = [tw.to_dict() for tw in t.towers.values()]
    payload["track"] = [f.to_dict() for f in (track or [])]
    payload["report"] = reports.target_report_metrics(case_id, msisdn, t, track, stats)
    content = json.dumps(payload, indent=2, default=str)
    return Response(
        content,
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{msisdn}_report.json"'},
    )


@app.get("/api/reports/export/case/{case_id}.csv")
def export_case_csv(
    case_id: str,
    user: dict = Depends(auth.require_active),
):
    case_id = case_id.lower()
    targets = CASES.get(case_id)
    if not targets:
        raise HTTPException(404, "unknown case")
    r = reports.case_report_metrics(
        case_id, targets, TRACKS.get(case_id, {}), STATS.get(case_id, {})
    )
    content = reports.case_summary_csv(r)
    return Response(
        content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{case_id}_summary.csv"'},
    )


@app.get("/api/reports/export/case/{case_id}.json")
def export_case_json(
    case_id: str,
    user: dict = Depends(auth.require_active),
):
    case_id = case_id.lower()
    targets = CASES.get(case_id)
    if not targets:
        raise HTTPException(404, "unknown case")
    r = reports.case_report_metrics(
        case_id, targets, TRACKS.get(case_id, {}), STATS.get(case_id, {})
    )
    r["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    r["generated_by"] = user["username"]
    content = json.dumps(r, indent=2, default=str)
    return Response(
        content,
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{case_id}_report.json"'},
    )


@app.websocket("/ws/live/{msisdn}")
async def live_track(websocket: WebSocket, msisdn: str):
    """Stream refined fixes as a realtime playback of the historical track."""
    # Auth first — token passed via query param (browsers can't set WS headers)
    token = websocket.query_params.get("token")
    payload = auth.verify_token(token or "")
    if payload is None:
        await websocket.accept()
        await websocket.send_json({"type": "error", "message": "unauthorized"})
        await websocket.close(code=4001)
        return
    await websocket.accept()
    # Case passed as query on WS URL: /ws/live/{msisdn}?case=fir47
    case = "erakshak"
    try:
        case = (websocket.query_params.get("case") or "erakshak").lower()
    except Exception:
        pass
    case, target, track, stats = _resolve(case, msisdn)
    if not track or not target:
        await websocket.send_json({"type": "error", "message": "unknown target"})
        await websocket.close()
        return

    await websocket.send_json({
        "type": "init",
        "target": _target_payload(case, msisdn, target),
        "stats": stats or {},
        "towers": [tw.to_dict() for tw in target.towers.values()],
        "total": len(track),
    })

    idx = 0
    playing = True
    speed = 8.0
    interval = 0.35

    try:
        while True:
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=0.01)
                data = json.loads(msg)
                cmd = data.get("cmd")
                if cmd == "pause":
                    playing = False
                elif cmd == "play":
                    playing = True
                elif cmd == "speed":
                    speed = float(data.get("value", 8))
                    interval = max(0.05, 0.35 / max(speed / 8.0, 0.25))
                elif cmd == "seek":
                    idx = max(0, min(int(data.get("index", 0)), len(track) - 1))
                elif cmd == "reset":
                    idx = 0
                    playing = True
            except asyncio.TimeoutError:
                pass
            except WebSocketDisconnect:
                return

            if playing and idx < len(track):
                fix = track[idx]
                await websocket.send_json({
                    "type": "fix",
                    "index": idx,
                    "total": len(track),
                    "fix": fix.to_dict(),
                })
                idx += 1
                await asyncio.sleep(interval)
            elif playing and idx >= len(track):
                await websocket.send_json({"type": "complete", "total": len(track)})
                playing = False
                await asyncio.sleep(0.25)
            else:
                await asyncio.sleep(0.1)
    except WebSocketDisconnect:
        return


# Serve frontend
if FRONTEND.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(FRONTEND / "index.html")

    @app.get("/{path:path}")
    def spa(path: str):
        candidate = FRONTEND / path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND / "index.html")
