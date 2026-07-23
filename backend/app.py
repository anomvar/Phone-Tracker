"""E-Rakshak Pinpoint — FastAPI backend with realtime WebSocket playback."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from parsers.cdr import load_all_targets
from parsers.fir47 import load_fir47_targets, fir47_summary
from engine import compute_track, baseline_single_tower_error

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"

app = FastAPI(title="E-Rakshak Pinpoint", version="1.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Case registries: case_id → {msisdn → Target}
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
        "cases": {cid: len(t) for cid, t in CASES.items()},
    }


@app.get("/api/cases")
def list_cases():
    return [
        {
            "id": "erakshak",
            "label": "E-Rakshak",
            "subtitle": "Hackathon CDR · Multi-operator",
            "targets": len(CASES.get("erakshak", {})),
        },
        {
            "id": "fir47",
            "label": "FIR 47",
            "subtitle": "NCCRP 222/2024 · Surat Cyber · Mora↔Jahangir",
            "targets": len(CASES.get("fir47", {})),
        },
    ]


@app.get("/api/targets")
def list_targets(case: str = Query("erakshak")):
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
def get_target(msisdn: str, case: str = Query("erakshak")):
    case, t, track, stats = _resolve(case, msisdn)
    if not t:
        return {"error": "not found"}
    payload = _target_payload(case, msisdn, t)
    payload["towers"] = [tw.to_dict() for tw in t.towers.values()]
    payload["track"] = [f.to_dict() for f in (track or [])]
    return payload


@app.get("/api/targets/{msisdn}/towers")
def get_towers(msisdn: str, case: str = Query("erakshak")):
    case, t, _, _ = _resolve(case, msisdn)
    if not t:
        return []
    return [tw.to_dict() for tw in t.towers.values()]


@app.get("/api/targets/{msisdn}/track")
def get_track(msisdn: str, case: str = Query("erakshak")):
    _, _, track, _ = _resolve(case, msisdn)
    return [f.to_dict() for f in (track or [])]


@app.websocket("/ws/live/{msisdn}")
async def live_track(websocket: WebSocket, msisdn: str):
    """Stream refined fixes as a realtime playback of the historical track."""
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
