"""Multi-operator CDR + LBS location parsers."""

from __future__ import annotations

import csv
import re
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Optional

from docx import Document

DATA_DIR = Path(__file__).resolve().parents[2] / "data"

LAT_LONG_RE = re.compile(
    r"(?:Lat[.\s:-]*|LAT\s*LONG\s*:?\s*)(-?\d+\.?\d*)[,\s/]+"
    r"(?:Long[.\s:-]*|)?(-?\d+\.?\d*)",
    re.I,
)
LAT_LONG_SLASH = re.compile(r"(-?\d+\.\d+)\s*/\s*(-?\d+\.\d+)")
VI_LAT_LONG = re.compile(r"Lat\.?\s*(-?\d+\.?\d*)\s*,?\s*Long\.?\s*(-?\d+\.?\d*)", re.I)
CGI_RE = re.compile(r"(\d{3})-(\d{2})-(\d+)-(\d+)")


@dataclass
class Ping:
    ts: datetime
    lat: float
    lon: float
    cgi: str
    tower_name: str = ""
    call_type: str = ""
    operator: str = ""
    msisdn: str = ""
    source: str = "cdr"  # cdr | lbs | cell-fusion
    deviation_m: Optional[float] = None
    # Pre-refined handset estimate (when set, engine prefers this over mast sector)
    handset_lat: Optional[float] = None
    handset_lon: Optional[float] = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["ts"] = self.ts.isoformat()
        d.pop("handset_lat", None)
        d.pop("handset_lon", None)
        return d


@dataclass
class Tower:
    cgi: str
    lat: float
    lon: float
    name: str = ""
    operator: str = ""
    hits: int = 0
    # Preferred handset azimuth from mast (deg clockwise from north).
    # When set, sector placement uses landward bearing instead of CGI-hash.
    phone_bearing_deg: Optional[float] = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("phone_bearing_deg", None)  # internal placement hint
        return d


@dataclass
class Target:
    msisdn: str
    operator: str
    label: str
    pings: list[Ping] = field(default_factory=list)
    towers: dict[str, Tower] = field(default_factory=dict)

    def to_summary(self) -> dict:
        lats = [p.lat for p in self.pings]
        lons = [p.lon for p in self.pings]
        return {
            "msisdn": self.msisdn,
            "operator": self.operator,
            "label": self.label,
            "ping_count": len(self.pings),
            "tower_count": len(self.towers),
            "t_start": self.pings[0].ts.isoformat() if self.pings else None,
            "t_end": self.pings[-1].ts.isoformat() if self.pings else None,
            "bbox": {
                "min_lat": min(lats) if lats else None,
                "max_lat": max(lats) if lats else None,
                "min_lon": min(lons) if lons else None,
                "max_lon": max(lons) if lons else None,
            },
            "center": {
                "lat": sum(lats) / len(lats) if lats else None,
                "lon": sum(lons) / len(lons) if lons else None,
            },
        }


def _parse_dt(date_s: str, time_s: str) -> Optional[datetime]:
    date_s = date_s.strip().strip("'")
    time_s = time_s.strip().strip("'")
    for fmt in (
        "%d/%m/%Y %H:%M:%S",
        "%d-%m-%Y %H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%d-%m-%Y %H:%M",
    ):
        try:
            return datetime.strptime(f"{date_s} {time_s}", fmt)
        except ValueError:
            continue
    return None


def _clean(s: str) -> str:
    return (s or "").strip().strip("'").strip('"').strip()


def _register_tower(
    towers: dict[str, Tower],
    cgi: str,
    lat: float,
    lon: float,
    name: str = "",
    operator: str = "",
    phone_bearing_deg: Optional[float] = None,
) -> None:
    if not cgi or lat == 0:
        return
    if cgi not in towers:
        towers[cgi] = Tower(
            cgi=cgi,
            lat=lat,
            lon=lon,
            name=name,
            operator=operator,
            hits=1,
            phone_bearing_deg=phone_bearing_deg,
        )
    else:
        t = towers[cgi]
        t.hits += 1
        # running average for slightly varying reported coords
        t.lat = (t.lat * (t.hits - 1) + lat) / t.hits
        t.lon = (t.lon * (t.hits - 1) + lon) / t.hits
        if name and not t.name:
            t.name = name
        if phone_bearing_deg is not None and t.phone_bearing_deg is None:
            t.phone_bearing_deg = phone_bearing_deg


def parse_airtel(path: Path) -> Target:
    msisdn = "9714499703"
    target = Target(msisdn=msisdn, operator="Airtel", label="Airtel · Surat")
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    header_idx = next(i for i, l in enumerate(lines) if l.startswith("Target No"))
    for line in lines[header_idx + 1 :]:
        if not line.strip():
            continue
        row = next(csv.reader([line]))
        if len(row) < 13:
            continue
        ts = _parse_dt(row[6], row[7])
        if not ts:
            continue
        call_type = _clean(row[1])
        pairs = [
            (_clean(row[9]), _clean(row[10])),
            (_clean(row[11]), _clean(row[12])),
        ]
        for latlong, cgi in pairs:
            if not cgi or cgi in ("---", "-", ""):
                continue
            m = LAT_LONG_SLASH.match(latlong)
            if not m:
                continue
            lat, lon = float(m.group(1)), float(m.group(2))
            # keep Gujarat/Surat corridor; drop rare long-haul outliers
            if not (20.5 <= lat <= 22.8 and 72.5 <= lon <= 73.5):
                continue
            _register_tower(target.towers, cgi, lat, lon, operator="Airtel")
            target.pings.append(
                Ping(ts=ts, lat=lat, lon=lon, cgi=cgi, call_type=call_type,
                     operator="Airtel", msisdn=msisdn, source="cdr")
            )
    target.pings.sort(key=lambda p: p.ts)
    return target


def parse_bsnl(path: Path) -> Target:
    msisdn = "9477523061"
    target = Target(msisdn=msisdn, operator="BSNL", label="BSNL · Kolkata")
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    header_idx = next(i for i, l in enumerate(lines) if l.startswith("Target/A-Party"))
    for line in lines[header_idx + 1 :]:
        if not line.strip():
            continue
        row = next(csv.reader([line]))
        if len(row) < 12:
            continue
        ts = _parse_dt(row[6], row[7])
        if not ts:
            continue
        loc = _clean(row[9])
        cgi = _clean(row[10])
        m = re.search(r"Lat-(-?\d+\.?\d*);\s*Long-(-?\d+\.?\d*)", loc)
        if not m or not cgi:
            continue
        lat, lon = float(m.group(1)), float(m.group(2))
        name = loc.split(";")[0]
        _register_tower(target.towers, cgi, lat, lon, name=name, operator="BSNL")
        target.pings.append(
            Ping(ts=ts, lat=lat, lon=lon, cgi=cgi, tower_name=name,
                 call_type=_clean(row[1]), operator="BSNL", msisdn=msisdn)
        )
    target.pings.sort(key=lambda p: p.ts)
    return target


def parse_vi(path: Path, lbs_fixes: list[Ping]) -> Target:
    """Vi CDRs lack lat/long; map cell addresses + LBS fixes to Rajkot coords."""
    msisdn = "8980261614"
    target = Target(msisdn=msisdn, operator="Vi", label="Vi · Rajkot")

    # Seed towers from LBS location document
    for fix in lbs_fixes:
        if fix.msisdn.endswith(msisdn) or fix.operator == "Vi":
            _register_tower(target.towers, fix.cgi, fix.lat, fix.lon,
                            name=fix.tower_name, operator="Vi")
            target.pings.append(fix)

    # Known address → approximate coords (from LBS + public map refs)
    address_coords = {
        "MAHUDI": (22.2690, 70.7874),
        "GOPAL PARK": (22.2660, 70.7885),
        "RAIYA CHOKDI": (22.2805, 70.7750),
        "HCG HOSPITAL": (22.2730, 70.7820),
        "SARASWATI": (22.2755, 70.7905),
        "SHIVSAGAR": (22.2660, 70.7885),
        "MAVDI": (22.2655, 70.7890),
        "CHANDRESH": (22.2690, 70.7874),
        "ASTHA": (22.2730, 70.7820),
    }

    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    header_idx = next(
        i for i, l in enumerate(lines)
        if "First BTS Location" in l or "First Cell Global" in l
    )
    # skip separator line if present
    start = header_idx + 1
    if start < len(lines) and lines[start].startswith("---"):
        start += 1

    for line in lines[start:]:
        if not line.strip() or line.startswith("---"):
            continue
        row = next(csv.reader([line]))
        if len(row) < 13:
            continue
        ts = _parse_dt(row[6].replace("-", "/"), row[7])
        if not ts:
            # try dd-mm-yyyy
            ts = _parse_dt(row[6], row[7])
        if not ts:
            continue
        loc = _clean(row[9]).upper()
        cgi = _clean(row[10])
        if not cgi:
            continue
        lat = lon = None
        for key, (la, lo) in address_coords.items():
            if key in loc:
                lat, lon = la, lo
                break
        if lat is None:
            continue
        # slight jitter so co-located sectors don't collapse perfectly
        h = abs(hash(cgi)) % 1000
        lat += ((h % 100) - 50) * 0.00002
        lon += ((h // 100) - 5) * 0.00002
        _register_tower(target.towers, cgi, lat, lon, name=loc[:60], operator="Vi")
        target.pings.append(
            Ping(ts=ts, lat=lat, lon=lon, cgi=cgi, tower_name=loc[:60],
                 call_type=_clean(row[1]), operator="Vi", msisdn=msisdn)
        )
    target.pings.sort(key=lambda p: p.ts)
    return target


def parse_jio(path: Path, lbs_fixes: list[Ping]) -> Target:
    """Jio CDRs use opaque Cell IDs; enrich with LBS lat/long from location doc."""
    msisdn = "9877535365"
    target = Target(msisdn=msisdn, operator="Jio", label="Jio · Surat")

    cell_to_coord: dict[str, tuple[float, float]] = {}
    for fix in lbs_fixes:
        if msisdn in fix.msisdn or fix.operator == "Jio":
            cell_to_coord[fix.cgi] = (fix.lat, fix.lon)
            _register_tower(target.towers, fix.cgi, fix.lat, fix.lon, operator="Jio")
            target.pings.append(fix)

    # Default Surat anchor from LBS
    default = (21.1245, 72.8296)
    if cell_to_coord:
        vals = list(cell_to_coord.values())
        default = (
            sum(v[0] for v in vals) / len(vals),
            sum(v[1] for v in vals) / len(vals),
        )

    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    # Find CSV header containing CELL
    header_idx = None
    for i, l in enumerate(lines):
        if "CELL" in l.upper() and ("DATE" in l.upper() or "START" in l.upper()):
            header_idx = i
            break
    if header_idx is None:
        target.pings.sort(key=lambda p: p.ts)
        return target

    header = [_clean(h) for h in next(csv.reader([lines[header_idx]]))]
    # Map columns loosely
    def col(*names):
        for n in names:
            for i, h in enumerate(header):
                if n.lower() in h.lower():
                    return i
        return None

    i_date = col("DATE")
    i_time = col("START TIME", "TIME")
    i_cell = col("CELL", "CGI")
    i_type = col("CALL TYPE", "TYPE")

    count = 0
    for line in lines[header_idx + 1 :]:
        if not line.strip():
            continue
        row = next(csv.reader([line]))
        if i_date is None or i_cell is None or max(i_date, i_cell) >= len(row):
            continue
        date_s = _clean(row[i_date])
        time_s = _clean(row[i_time]) if i_time is not None else "00:00:00"
        # Jio sometimes splits date/time oddly
        if " " in date_s and not time_s:
            parts = date_s.split()
            date_s, time_s = parts[0], parts[1] if len(parts) > 1 else "00:00:00"
        ts = _parse_dt(date_s, time_s)
        if not ts:
            continue
        cgi = _clean(row[i_cell])
        if not cgi:
            continue
        if cgi in cell_to_coord:
            lat, lon = cell_to_coord[cgi]
        else:
            # Place unknown cells in a ring around the LBS anchor (multi-tower sim)
            h = abs(hash(cgi)) % 360
            import math
            r = 0.003 + (abs(hash(cgi[::-1])) % 50) * 0.00008
            lat = default[0] + r * math.cos(math.radians(h))
            lon = default[1] + r * math.sin(math.radians(h))
        _register_tower(target.towers, cgi, lat, lon, operator="Jio")
        target.pings.append(
            Ping(
                ts=ts, lat=lat, lon=lon, cgi=cgi,
                call_type=_clean(row[i_type]) if i_type is not None else "",
                operator="Jio", msisdn=msisdn,
            )
        )
        count += 1
        if count >= 2500:  # keep playback responsive
            break
    target.pings.sort(key=lambda p: p.ts)
    return target


def parse_location_docx(path: Path) -> list[Ping]:
    """Parse LBS snapshots from Location Data_E-Rakshak.docx."""
    doc = Document(str(path))
    fixes: list[Ping] = []
    operators = ["Jio", "Vi", "Airtel", "BSNL"]

    for ti, table in enumerate(doc.tables):
        operator = operators[ti] if ti < len(operators) else f"Op{ti}"
        for ri, row in enumerate(table.rows):
            if ri == 0:
                continue
            text = row.cells[-1].text.strip()
            if not text:
                continue
            msisdn_m = re.search(r"(?:MSISDN|MOB)\s*(\d{10,15})", text, re.I)
            msisdn = msisdn_m.group(1) if msisdn_m else ""
            cgi_m = re.search(
                r"(?:Cell ID|CGI|CELLID)\s*:?\s*([0-9A-Fa-f\-]+)", text, re.I
            )
            cgi = cgi_m.group(1).strip() if cgi_m else f"LBS-{operator}-{ri}"
            lat = lon = None
            m = re.search(r"Lat\.?\s*(-?\d+\.?\d*)\s*,?\s*Long\.?\s*(-?\d+\.?\d*)", text, re.I)
            if m:
                lat, lon = float(m.group(1)), float(m.group(2))
            if lat is None:
                m = re.search(r"LAT\s*LONG\s*:?\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)", text, re.I)
                if m:
                    lat, lon = float(m.group(1)), float(m.group(2))
            if lat is None:
                m = re.search(r"Lat\s+(-?\d+\.?\d+)\s*\n?\s*Long\s+(-?\d+\.?\d+)", text, re.I)
                if m:
                    lat, lon = float(m.group(1)), float(m.group(2))
            if lat is None:
                continue
            # timestamp
            ts = None
            for pat, fmt in (
                (r"LBS Dttm\s+(\d{2}-\w{3}-\d{4}\s+\d{2}:\d{2}:\d{2})", "%d-%b-%Y %H:%M:%S"),
                (r"Last Activity\s+(\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2}:\d{2})", "%d/%m/%Y %H:%M:%S"),
                (r"L\.\s*Act\.\s+(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})", "%d-%m-%Y %H:%M:%S"),
            ):
                tm = re.search(pat, text, re.I)
                if tm:
                    try:
                        ts = datetime.strptime(tm.group(1), fmt)
                    except ValueError:
                        pass
                    break
            if ts is None:
                ts = datetime(2026, 7, 8, 12, 0, 0)
            dev_m = re.search(r"Deviation:(-?\d+\.?\d*)\s*mtrs", text, re.I)
            aol_m = re.search(r"AOL:(\d+)", text, re.I)
            deviation = float(dev_m.group(1)) if dev_m else (float(aol_m.group(1)) if aol_m else None)
            tower_m = re.search(r'TOWER:"([^"]+)"', text)
            name = tower_m.group(1) if tower_m else ""
            addr_m = re.search(r"Cell ID Address\s+(.+?)(?:IMEI|IMSI|VLR|$)", text, re.S)
            if addr_m and not name:
                name = addr_m.group(1).strip()[:80]
            fixes.append(
                Ping(
                    ts=ts, lat=lat, lon=lon, cgi=cgi, tower_name=name,
                    operator=operator, msisdn=msisdn, source="lbs",
                    deviation_m=deviation,
                )
            )
    return fixes


def load_all_targets() -> dict[str, Target]:
    lbs = parse_location_docx(DATA_DIR / "Location Data_E-Rakshak.docx")
    targets = {
        "9714499703": parse_airtel(DATA_DIR / "9714499703_Airtel.csv"),
        "8980261614": parse_vi(DATA_DIR / "8980261614_Vi.csv", lbs),
        "9877535365": parse_jio(DATA_DIR / "9877535365_Jio.csv", lbs),
        "9477523061": parse_bsnl(DATA_DIR / "9477523061_BSNL.csv"),
    }
    # Drop empty
    return {k: v for k, v in targets.items() if v.pings}
