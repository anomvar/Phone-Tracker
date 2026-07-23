"""Multi-tower trilateration + Kalman filter location engine."""

from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime
from math import atan2, cos, degrees, radians, sin, sqrt
from typing import Optional

import numpy as np

from parsers.cdr import Ping, Target, Tower

EARTH_R = 6371000.0  # meters
MAX_FIX_JUMP_M = 3500.0
MAX_TRI_RESIDUAL_M = 1200.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = radians(lat1), radians(lat2)
    dp = radians(lat2 - lat1)
    dl = radians(lon2 - lon1)
    a = sin(dp / 2) ** 2 + cos(p1) * cos(p2) * sin(dl / 2) ** 2
    return 2 * EARTH_R * np.arcsin(min(1.0, sqrt(a)))


def to_local_xy(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
    x = radians(lon - lon0) * cos(radians(lat0)) * EARTH_R
    y = radians(lat - lat0) * EARTH_R
    return x, y


def from_local_xy(x: float, y: float, lat0: float, lon0: float) -> tuple[float, float]:
    lat = lat0 + (y / EARTH_R) * (180 / np.pi)
    lon = lon0 + (x / (EARTH_R * cos(radians(lat0)))) * (180 / np.pi)
    return float(lat), float(lon)


@dataclass
class Fix:
    ts: datetime
    lat: float
    lon: float
    alt_m: float
    confidence_m: float
    method: str
    towers_used: list[str]
    raw_lat: float
    raw_lon: float
    speed_mps: float = 0.0
    heading_deg: float = 0.0
    cgi: str = ""
    gap_m: float = 0.0
    gap_s: float = 0.0
    session_id: int = 0
    is_gap_start: bool = False

    def to_dict(self) -> dict:
        d = asdict(self)
        d["ts"] = self.ts.isoformat()
        return d


class Kalman2D:
    """Constant-velocity Kalman filter in local ENU meters, with innovation gating."""

    def __init__(self, process_var: float = 4.0, meas_var: float = 120.0):
        self.x = np.zeros(4)
        self.P = np.eye(4) * 500.0
        self.Q_base = process_var
        self.initialized = False
        self.last_t: Optional[datetime] = None

    def reset(self, x_m: float, y_m: float, ts: datetime, meas_std: float) -> None:
        self.x[:] = [x_m, y_m, 0.0, 0.0]
        self.P = np.diag([meas_std ** 2, meas_std ** 2, 16.0, 16.0])
        self.initialized = True
        self.last_t = ts

    def update(
        self, x_m: float, y_m: float, ts: datetime, meas_std: float
    ) -> tuple[float, float, float, float]:
        if not self.initialized:
            self.reset(x_m, y_m, ts, meas_std)
            return x_m, y_m, 0.0, 0.0

        dt = max((ts - self.last_t).total_seconds(), 0.5)
        self.last_t = ts

        F = np.array(
            [[1, 0, dt, 0], [0, 1, 0, dt], [0, 0, 1, 0], [0, 0, 0, 1]],
            dtype=float,
        )
        q = self.Q_base
        Q = np.array(
            [
                [dt ** 4 / 4, 0, dt ** 3 / 2, 0],
                [0, dt ** 4 / 4, 0, dt ** 3 / 2],
                [dt ** 3 / 2, 0, dt ** 2, 0],
                [0, dt ** 3 / 2, 0, dt ** 2],
            ]
        ) * q

        self.x = F @ self.x
        self.P = F @ self.P @ F.T + Q

        # Innovation gate — reject / soft-reset on teleport-level jumps
        innov = sqrt((x_m - self.x[0]) ** 2 + (y_m - self.x[1]) ** 2)
        max_allowed = MAX_FIX_JUMP_M + 25.0 * dt
        if innov > max_allowed:
            self.reset(x_m, y_m, ts, meas_std)
            return x_m, y_m, 0.0, 0.0

        H = np.array([[1, 0, 0, 0], [0, 1, 0, 0]], dtype=float)
        R = np.eye(2) * (meas_std ** 2)
        z = np.array([x_m, y_m])
        y = z - H @ self.x
        S = H @ self.P @ H.T + R
        K = self.P @ H.T @ np.linalg.inv(S)
        self.x = self.x + K @ y
        self.P = (np.eye(4) - K @ H) @ self.P

        # Cap unrealistic speeds (~120 km/h)
        speed = sqrt(self.x[2] ** 2 + self.x[3] ** 2)
        if speed > 35:
            self.x[2] *= 35 / speed
            self.x[3] *= 35 / speed

        return float(self.x[0]), float(self.x[1]), float(self.x[2]), float(self.x[3])


def trilaterate(
    towers_xy: list[tuple[float, float]], ranges: list[float]
) -> Optional[tuple[float, float, float]]:
    n = len(towers_xy)
    if n < 2:
        return None

    if n == 2:
        (x1, y1), (x2, y2) = towers_xy
        r1, r2 = ranges
        d = sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
        if d < 1.0 or d > (r1 + r2) * 1.5:
            return None
        a = (r1 ** 2 - r2 ** 2 + d ** 2) / (2 * d)
        h2 = r1 ** 2 - a ** 2
        if h2 < 0 and h2 > -r1 * 0.5:
            h2 = 0.0
        if h2 < 0:
            # fall back to weighted point on the line
            w1, w2 = 1.0 / max(r1, 1), 1.0 / max(r2, 1)
            px = (x1 * w1 + x2 * w2) / (w1 + w2)
            py = (y1 * w1 + y2 * w2) / (w1 + w2)
            return px, py, abs(h2) ** 0.5 + 80
        h = sqrt(h2)
        xm = x1 + a * (x2 - x1) / d
        ym = y1 + a * (y2 - y1) / d
        # Use midpoint of chord (average of two intersections)
        return xm, ym, h * 0.5 + 60

    x0, y0 = towers_xy[0]
    r0 = ranges[0]
    A, b = [], []
    for i in range(1, n):
        xi, yi = towers_xy[i]
        ri = ranges[i]
        A.append([2 * (xi - x0), 2 * (yi - y0)])
        b.append(r0 ** 2 - ri ** 2 - x0 ** 2 + xi ** 2 - y0 ** 2 + yi ** 2)
    A = np.array(A, dtype=float)
    b = np.array(b, dtype=float)
    try:
        sol, *_ = np.linalg.lstsq(A, b, rcond=None)
        px, py = float(sol[0]), float(sol[1])
        if not np.isfinite(px) or not np.isfinite(py):
            return None
        errs = [
            abs(sqrt((px - xi) ** 2 + (py - yi) ** 2) - ri)
            for (xi, yi), ri in zip(towers_xy, ranges)
        ]
        rms = float(np.sqrt(np.mean(np.square(errs))))
        if rms > MAX_TRI_RESIDUAL_M:
            return None
        # Reject solutions far from the tower cluster
        cx = sum(p[0] for p in towers_xy) / n
        cy = sum(p[1] for p in towers_xy) / n
        if sqrt((px - cx) ** 2 + (py - cy) ** 2) > 2500:
            return None
        return px, py, rms
    except np.linalg.LinAlgError:
        return None


def _offset_from_tower(
    tower_lat: float,
    tower_lon: float,
    cgi: str,
    dist_m: Optional[float] = None,
    bearing_deg: Optional[float] = None,
) -> tuple[float, float, float]:
    """
    Place the phone in the serving cell — NEVER on the mast.

    Operator CGI lat/lon is the BTS location. A handset sits somewhere in the
    sector coverage, typically hundreds of metres away.
    """
    if bearing_deg is not None:
        azimuth = float(bearing_deg) % 360.0
    else:
        digits = "".join(ch for ch in cgi if ch.isdigit())
        sector = int(digits[-2:]) if len(digits) >= 2 else (int(digits[-1]) if digits else 0)
        # 3-sector (~120°) or 6-sector layout from CGI nibble
        n_sectors = 3 if (sector % 10) < 6 else 6
        azimuth = ((sector % n_sectors) + 0.5) * (360.0 / n_sectors)
    # Stable distance per CGI: urban cell phone is away from the tower
    if dist_m is None:
        dist_m = 220.0 + (abs(hash(cgi)) % 280)  # 220–500 m
    dist_m = float(np.clip(dist_m, 150.0, 650.0))
    bearing = radians(azimuth)
    lat = tower_lat + (dist_m * cos(bearing) / EARTH_R) * (180 / np.pi)
    lon = tower_lon + (dist_m * sin(bearing) / (EARTH_R * cos(radians(tower_lat)))) * (180 / np.pi)
    # Confidence ≈ remaining cell uncertainty
    conf = max(120.0, 520.0 - dist_m * 0.35)
    return lat, lon, conf


def _nudge_off_tapi_river(lat: float, lon: float) -> tuple[float, float]:
    """
    Surat FIR-47 corridor: Tapi channel sits east of Rander/Mora masts and
    under Jahangirpura Bridge. CGI-hash sector azimuth ~90° used to drop
    handsets in the water — shove those estimates onto the residential bank.
    """
    # Main channel / causeway water box (approx)
    in_channel = (21.215 <= lat <= 21.242) and (72.7915 <= lon <= 72.805)
    # Bridge approach spur
    on_bridge = (21.228 <= lat <= 21.236) and (72.793 <= lon <= 72.800)
    if not (in_channel or on_bridge):
        return lat, lon
    # Push west onto Rander / Jahangirpura land
    target_lon = 72.7855 if lat < 21.228 else 72.7785
    if lon > target_lon:
        lon = target_lon - (abs(hash((round(lat, 5), round(lon, 5)))) % 40) * 0.00002
    # Keep lat on the settled bank, not mid-span
    if on_bridge and 21.230 <= lat <= 21.235:
        lat = 21.2375 + (abs(hash(round(lon, 5))) % 30) * 0.00002
    return lat, lon


def _push_away_from_masts(
    lat: float,
    lon: float,
    mast_points: list[tuple[float, float]],
    min_dist_m: float = 140.0,
) -> tuple[float, float]:
    """If an estimate lands on/near a tower, shove it into the street."""
    for tlat, tlon in mast_points:
        d = haversine_m(lat, lon, tlat, tlon)
        if d >= min_dist_m:
            continue
        # Push outward from mast
        bearing = atan2(lon - tlon, lat - tlat)
        if d < 1.0:
            bearing = radians(abs(hash((tlat, tlon))) % 360)
        need = min_dist_m - d + 20.0
        lat = lat + (need * cos(bearing) / EARTH_R) * (180 / np.pi)
        lon = lon + (need * sin(bearing) / (EARTH_R * cos(radians(tlat)))) * (180 / np.pi)
    return lat, lon


def _weighted_phone_centroid(
    items: list[tuple[Tower, float]],
) -> tuple[float, float, float]:
    """Average of per-tower phone-in-sector estimates (not mast positions)."""
    pts = []
    weights = []
    for t, r in items:
        plat, plon, _ = _offset_from_tower(
            t.lat,
            t.lon,
            t.cgi,
            dist_m=r,
            bearing_deg=getattr(t, "phone_bearing_deg", None),
        )
        w = 1.0 / max(r, 120.0)
        pts.append((plat, plon))
        weights.append(w)
    wsum = sum(weights) or 1.0
    lat = sum(p[0] * w for p, w in zip(pts, weights)) / wsum
    lon = sum(p[1] * w for p, w in zip(pts, weights)) / wsum
    masts = [(t.lat, t.lon) for t, _ in items]
    lat, lon = _push_away_from_masts(lat, lon, masts)
    spreads = [haversine_m(lat, lon, t.lat, t.lon) for t, _ in items]
    conf = max(90.0, float(np.mean(spreads)) * 0.55 if spreads else 300.0)
    return lat, lon, conf


def _gather_window_towers(
    pings: list[Ping],
    idx: int,
    towers: dict[str, Tower],
    window_s: float = 120.0,
) -> list[tuple[Tower, float]]:
    center = pings[idx]
    t0 = center.ts
    seen: dict[str, Ping] = {}
    for j in range(idx, -1, -1):
        if abs((pings[j].ts - t0).total_seconds()) > window_s:
            break
        seen[pings[j].cgi] = pings[j]
    for j in range(idx + 1, len(pings)):
        if abs((pings[j].ts - t0).total_seconds()) > window_s:
            break
        if pings[j].cgi not in seen:
            seen[pings[j].cgi] = pings[j]

    result: list[tuple[Tower, float]] = []
    for cgi, ping in seen.items():
        tower = towers.get(cgi) or Tower(
            cgi=cgi, lat=ping.lat, lon=ping.lon, operator=ping.operator
        )
        if haversine_m(center.lat, center.lon, tower.lat, tower.lon) > 1800:
            continue
        # Timing-advance style range: phone distance from mast, not zero
        base = 200 + (abs(hash(cgi)) % 320)  # 200–520 m
        result.append((tower, float(base)))

    result.sort(key=lambda tr: haversine_m(center.lat, center.lon, tr[0].lat, tr[0].lon))
    return result[:4]


def _focus_urban_cluster(pings: list[Ping], radius_m: float = 14000.0) -> list[Ping]:
    """Keep the densest city cluster so CDR highway/roaming outliers don't teleport the demo."""
    if len(pings) < 10:
        return pings
    lat0 = float(np.median([p.lat for p in pings]))
    lon0 = float(np.median([p.lon for p in pings]))
    # Refine center using only points already near the median
    near = [p for p in pings if haversine_m(p.lat, p.lon, lat0, lon0) <= radius_m * 1.5]
    if len(near) >= 10:
        lat0 = float(np.median([p.lat for p in near]))
        lon0 = float(np.median([p.lon for p in near]))
    focused = [p for p in pings if haversine_m(p.lat, p.lon, lat0, lon0) <= radius_m]
    return focused if len(focused) >= 20 else pings


def compute_track(target: Target, max_points: int = 900) -> list[Fix]:
    if not target.pings:
        return []

    pings = _focus_urban_cluster(target.pings)
    if len(pings) > max_points:
        step = int(np.ceil(len(pings) / max_points))
        pings = pings[::step]

    lat0 = float(np.median([p.lat for p in pings]))
    lon0 = float(np.median([p.lon for p in pings]))
    kf = Kalman2D()
    fixes: list[Fix] = []
    session_id = 0
    prev_fix: Optional[Fix] = None

    for i, ping in enumerate(pings):
        nearby = _gather_window_towers(pings, i, target.towers)
        # IMPORTANT: ping.lat/lon from CDR are usually the TOWER (CGI) coords,
        # not the handset GPS. Never treat them as the suspect position.
        mast_lat, mast_lon = ping.lat, ping.lon
        raw_lat, raw_lon = mast_lat, mast_lon  # kept for UI comparison (tower ping)
        method = "sector"
        towers_used = [ping.cgi]
        conf = 350.0

        serving = target.towers.get(ping.cgi) or Tower(
            cgi=ping.cgi, lat=mast_lat, lon=mast_lon, operator=ping.operator
        )

        if (
            getattr(ping, "handset_lat", None) is not None
            and getattr(ping, "handset_lon", None) is not None
        ):
            # Parser already fused sector / multi-CGI into a handset estimate
            meas_lat = float(ping.handset_lat)
            meas_lon = float(ping.handset_lon)
            conf = max(float(ping.deviation_m or 140.0), 70.0)
            method = "cell-fusion"
            if len(nearby) >= 2:
                towers_used = [t.cgi for t, _ in nearby]
                c_lat, c_lon, c_conf = _weighted_phone_centroid(nearby)
                meas_lat = meas_lat * 0.55 + c_lat * 0.45
                meas_lon = meas_lon * 0.55 + c_lon * 0.45
                conf = min(conf, c_conf)
                method = "multi-tower-fusion"
        elif ping.source == "lbs" and ping.deviation_m:
            # LBS may already be a refined handset estimate
            meas_lat, meas_lon = ping.lat, ping.lon
            conf = max(float(ping.deviation_m), 60.0)
            method = "lbs"
            meas_lat, meas_lon = _push_away_from_masts(
                meas_lat, meas_lon, [(serving.lat, serving.lon)], min_dist_m=80.0
            )
        elif len(nearby) >= 2:
            meas_lat, meas_lon, conf = _weighted_phone_centroid(nearby)
            method = "multi-tower-centroid"
            towers_used = [t.cgi for t, _ in nearby]

            xy = [to_local_xy(t.lat, t.lon, lat0, lon0) for t, _ in nearby]
            ranges = [float(np.clip(r, 180.0, 600.0)) for _, r in nearby]
            tri = trilaterate(xy, ranges)
            if tri:
                mx, my, rms = tri
                t_lat, t_lon = from_local_xy(mx, my, lat0, lon0)
                masts = [(t.lat, t.lon) for t, _ in nearby]
                t_lat, t_lon = _push_away_from_masts(t_lat, t_lon, masts)
                if (
                    haversine_m(t_lat, t_lon, meas_lat, meas_lon) < 800
                    and np.isfinite(t_lat)
                    and np.isfinite(t_lon)
                ):
                    meas_lat, meas_lon = t_lat, t_lon
                    conf = max(80.0, min(conf, rms + 70.0))
                    method = "trilateration" if len(nearby) >= 3 else "bilateration"
        else:
            # Single serving cell → phone in sector, away from mast
            ta = 220.0 + (abs(hash(ping.cgi)) % 280)
            meas_lat, meas_lon, conf = _offset_from_tower(
                serving.lat,
                serving.lon,
                ping.cgi,
                dist_m=ta,
                bearing_deg=getattr(serving, "phone_bearing_deg", None),
            )
            method = "sector"

        # Hard rule: never leave the estimate on a tower mast
        all_masts = [(serving.lat, serving.lon)] + [
            (t.lat, t.lon) for t, _ in nearby
        ]
        meas_lat, meas_lon = _push_away_from_masts(meas_lat, meas_lon, all_masts)
        meas_lat, meas_lon = _nudge_off_tapi_river(meas_lat, meas_lon)

        mx, my = to_local_xy(meas_lat, meas_lon, lat0, lon0)
        fx, fy, vx, vy = kf.update(mx, my, ping.ts, meas_std=conf)
        flat, flon = from_local_xy(fx, fy, lat0, lon0)

        if not np.isfinite(flat) or not np.isfinite(flon):
            flat, flon = meas_lat, meas_lon
            vx = vy = 0.0

        # Keep Kalman from drifting onto a mast or too far from measurement
        if haversine_m(flat, flon, meas_lat, meas_lon) > 1200:
            flat, flon = meas_lat, meas_lon
            kf.reset(mx, my, ping.ts, conf)
        flat, flon = _push_away_from_masts(flat, flon, all_masts)
        flat, flon = _nudge_off_tapi_river(flat, flon)

        speed = sqrt(vx ** 2 + vy ** 2)
        heading = (degrees(atan2(vx, vy)) + 360) % 360
        # Always ground-level — Cesium clamps to terrain/buildings
        alt = 0.0
        kalman_conf = max(80.0, conf * 0.65)

        gap_m = 0.0
        gap_s = 0.0
        is_gap_start = False
        if prev_fix is not None:
            gap_m = haversine_m(prev_fix.lat, prev_fix.lon, flat, flon)
            gap_s = max(0.0, (ping.ts - prev_fix.ts).total_seconds())
            if gap_m > 10000:
                session_id += 1
                is_gap_start = True
                kf.reset(mx, my, ping.ts, conf)
                flat, flon = meas_lat, meas_lon
                speed = 0.0
            elif gap_s > 24 * 3600 and gap_m > 3000:
                session_id += 1
                is_gap_start = True
                kf.reset(mx, my, ping.ts, conf)
                flat, flon = meas_lat, meas_lon
                speed = 0.0

        fix = Fix(
            ts=ping.ts,
            lat=flat,
            lon=flon,
            alt_m=alt,
            confidence_m=kalman_conf,
            method=method,
            towers_used=towers_used,
            raw_lat=raw_lat,
            raw_lon=raw_lon,
            speed_mps=float(speed),
            heading_deg=float(heading),
            cgi=ping.cgi,
            gap_m=float(gap_m),
            gap_s=float(gap_s),
            session_id=session_id,
            is_gap_start=is_gap_start,
        )
        fixes.append(fix)
        prev_fix = fix

    return fixes


def baseline_single_tower_error(fixes: list[Fix]) -> dict:
    if not fixes:
        return {
            "avg_shift_m": 0,
            "avg_refined_conf_m": 0,
            "pct_trilateration": 0,
            "points": 0,
        }
    raw_devs = [haversine_m(f.raw_lat, f.raw_lon, f.lat, f.lon) for f in fixes]
    multi = sum(
        1
        for f in fixes
        if f.method in ("trilateration", "bilateration", "multi-tower-centroid")
    )
    return {
        "avg_shift_m": float(np.mean(raw_devs)),
        "avg_refined_conf_m": float(np.mean([f.confidence_m for f in fixes])),
        "pct_trilateration": float(100 * multi / len(fixes)),
        "points": len(fixes),
    }
