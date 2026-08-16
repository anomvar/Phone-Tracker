"""Report builder — case/target intelligence summaries + CSV/JSON exports.

Pure functions operating on the case registries; ``app.py`` supplies the data.
"""

from __future__ import annotations

import csv
import io
from collections import Counter
from datetime import datetime
from typing import Optional

from engine import haversine_m

CLASSIFICATION = "RESTRICTED"


def _fmt_ts(ts) -> Optional[str]:
    if ts is None:
        return None
    if isinstance(ts, datetime):
        return ts.isoformat()
    return str(ts)


def _hours(d: Optional[datetime], e: Optional[datetime]) -> Optional[float]:
    if not d or not e:
        return None
    return max(0.0, (e - d).total_seconds() / 3600.0)


# --------------------------------------------------------------------------
# Target-level metrics
# --------------------------------------------------------------------------


def _split_sessions(fixes) -> list[list]:
    sessions: list[list] = []
    cur: list = []
    for f in fixes:
        if f.is_gap_start and cur:
            sessions.append(cur)
            cur = []
        cur.append(f)
    if cur:
        sessions.append(cur)
    return sessions


def target_report_metrics(msisdn: str, case_id: str, target, track, stats) -> dict:
    fixes = track or []
    sessions = _split_sessions(fixes)
    session_rows = []
    total_dist = 0.0
    speeds: list[float] = []
    hourly = Counter()
    methods = Counter()
    tower_hits: Counter = Counter()
    conf = []

    for f in fixes:
        total_dist += f.gap_m if (not f.is_gap_start and f.gap_m < 10000) else 0.0
        speeds.append(f.speed_mps)
        hourly[f.ts.hour] += 1
        methods[f.method] += 1
        conf.append(f.confidence_m)
        for c in f.towers_used or []:
            tower_hits[str(c)] += 1
        if f.cgi:
            tower_hits[str(f.cgi)] += 1

    for sid, seg in enumerate(sessions):
        if not seg:
            continue
        dist = sum(s.gap_m for s in seg[1:] if not s.is_gap_start and s.gap_m < 10000)
        session_rows.append(
            {
                "id": sid + 1,
                "start": _fmt_ts(seg[0].ts),
                "end": _fmt_ts(seg[-1].ts),
                "points": len(seg),
                "distance_km": round(dist / 1000.0, 2),
            }
        )

    top_towers = []
    for cgi, hits in tower_hits.most_common(12):
        tw = (target.towers or {}).get(cgi)
        top_towers.append(
            {
                "cgi": cgi,
                "name": (tw.name if tw else "")[:60],
                "operator": tw.operator if tw else "",
                "lat": round(tw.lat, 6) if tw else None,
                "lon": round(tw.lon, 6) if tw else None,
                "hits": hits,
                "share": round(100.0 * hits / max(len(fixes), 1), 1),
            }
        )

    summary = target.to_summary() if hasattr(target, "to_summary") else {}
    speeds = [s for s in speeds if s > 0]
    conf = [c for c in conf if c is not None]
    return {
        "type": "target",
        "classification": CLASSIFICATION,
        "case_id": case_id,
        "msisdn": msisdn,
        "name": getattr(target, "_fir_name", "") or "",
        "operator": getattr(target, "operator", ""),
        "label": getattr(target, "label", msisdn),
        "coverage": {
            "start": _fmt_ts(fixes[0].ts) if fixes else None,
            "end": _fmt_ts(fixes[-1].ts) if fixes else None,
            "duration_h": _hours(fixes[0].ts, fixes[-1].ts) if fixes else None,
            "ping_count": len(fixes),
            "tower_count": len(target.towers or {}),
        },
        "metrics": {
            "distance_km": round(total_dist / 1000.0, 2),
            "max_speed_kmh": round(max(speeds, default=0.0) * 3.6, 1),
            "avg_speed_kmh": round((sum(speeds) / len(speeds)) * 3.6, 1) if speeds else 0.0,
            "avg_confidence_m": round(sum(conf) / len(conf), 1) if conf else 0.0,
            "tri_pct": round(float(stats.get("pct_trilateration", 0.0)), 1) if stats else 0.0,
            "sessions": len(session_rows),
            "longest_gap_h": (
                round(max((f.gap_s or 0) for f in fixes[1:]) / 3600.0, 1) if len(fixes) > 1 else 0.0
            ),
        },
        "bbox": summary.get("bbox"),
        "center": summary.get("center"),
        "hourly": [hourly.get(h, 0) for h in range(24)],
        "by_method": dict(methods),
        "top_towers": top_towers,
        "sessions": session_rows,
        "confidence": {
            "min": round(min(conf), 1) if conf else 0.0,
            "max": round(max(conf), 1) if conf else 0.0,
            "avg": round(sum(conf) / len(conf), 1) if conf else 0.0,
        },
    }


# --------------------------------------------------------------------------
# Case-level metrics
# --------------------------------------------------------------------------


def case_report_metrics(case_id: str, targets, tracks, stats, subtitle: str = "") -> dict:
    rows = []
    for msisdn, target in targets.items():
        m = target_report_metrics(msisdn, case_id, target, tracks.get(msisdn, []), stats.get(msisdn, {}))
        c = m["metrics"]
        rows.append(
            {
                "msisdn": msisdn,
                "name": m["name"] or "",
                "operator": m["operator"],
                "ping_count": len(tracks.get(msisdn) or []),
                "tower_count": m["coverage"]["tower_count"],
                "start": m["coverage"]["start"],
                "end": m["coverage"]["end"],
                "distance_km": c["distance_km"],
                "max_speed_kmh": c["max_speed_kmh"],
                "avg_confidence_m": c["avg_confidence_m"],
                "tri_pct": c["tri_pct"],
                "sessions": c["sessions"],
                "sites": list(getattr(target, "_fir_sites", [])) or [],
                "corridor": bool(getattr(target, "_fir_corridor", False)),
                "label": m["label"],
            }
        )

    starts = [r["start"] for r in rows if r["start"]]
    ends = [r["end"] for r in rows if r["end"]]
    operators = sorted({r["operator"] for r in rows if r["operator"]})
    corridors = [r for r in rows if r["corridor"]]
    return {
        "type": "case",
        "classification": CLASSIFICATION,
        "case_id": case_id,
        "subtitle": subtitle,
        "period": {
            "start": min(starts) if starts else None,
            "end": max(ends) if ends else None,
            "duration_h": _hours(
                datetime.fromisoformat(min(starts)) if starts else None,
                datetime.fromisoformat(max(ends)) if ends else None,
            ),
        },
        "summary": {
            "targets": len(rows),
            "total_pings": sum(r["ping_count"] for r in rows),
            "total_towers": sum(r["tower_count"] for r in rows),
            "total_distance_km": round(sum(r["distance_km"] for r in rows), 2),
            "operators": operators,
            "corridor_targets": len(corridors),
        },
        "targets": rows,
    }


# --------------------------------------------------------------------------
# CSV / JSON exports
# --------------------------------------------------------------------------


def track_csv(fixes) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "index",
            "timestamp",
            "lat",
            "lon",
            "alt_m",
            "confidence_m",
            "method",
            "cgi",
            "towers_used",
            "speed_mps",
            "speed_kmh",
            "heading_deg",
            "raw_lat",
            "raw_lon",
            "gap_m",
            "gap_s",
            "session_id",
        ]
    )
    for i, f in enumerate(fixes):
        w.writerow(
            [
                i,
                f.ts.isoformat(),
                f"{f.lat:.7f}",
                f"{f.lon:.7f}",
                f"{f.alt_m:.1f}",
                f"{f.confidence_m:.1f}",
                f.method,
                f.cgi,
                "|".join(f.towers_used or []),
                f"{f.speed_mps:.2f}",
                f"{f.speed_mps * 3.6:.1f}",
                f"{f.heading_deg:.1f}",
                f"{f.raw_lat:.7f}" if f.raw_lat is not None else "",
                f"{f.raw_lon:.7f}" if f.raw_lon is not None else "",
                f"{f.gap_m:.1f}",
                f"{f.gap_s:.1f}",
                f.session_id,
            ]
        )
    return buf.getvalue()


def case_summary_csv(case_report: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "msisdn",
            "name",
            "operator",
            "ping_count",
            "tower_count",
            "start",
            "end",
            "distance_km",
            "max_speed_kmh",
            "avg_confidence_m",
            "tri_pct",
            "sessions",
            "sites",
            "corridor",
        ]
    )
    for r in case_report["targets"]:
        w.writerow(
            [
                r["msisdn"],
                r["name"],
                r["operator"],
                r["ping_count"],
                r["tower_count"],
                r["start"] or "",
                r["end"] or "",
                r["distance_km"],
                r["max_speed_kmh"],
                r["avg_confidence_m"],
                r["tri_pct"],
                r["sessions"],
                "|".join(r["sites"]),
                "Y" if r["corridor"] else "",
            ]
        )
    return buf.getvalue()
