# E-Rakshak Pinpoint (ERH26_PS_09)

3D multi-tower trilateration & Kalman-filtered suspect tracker for the E-Rakshak Hackathon problem **Telecom Tower Data Multi-Lateration & High-Precision Suspect Pinpointer**.

## Features

- Parses real multi-operator CDR + LBS datasets (Airtel, Vi, Jio, BSNL)
- Multi-tower trilateration with timing-advance style ranging
- 2D constant-velocity Kalman filter for track smoothing
- CesiumJS **3D** globe with live suspect marker, confidence volume, tower cylinders, trilateration beams, and heat corridor
- WebSocket realtime playback of historical tracks

## Quick start

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8080 --reload
```

Open **http://localhost:8080**

## Dataset

Place operator CSVs and `Location Data_E-Rakshak.docx` under `data/` (already included).

| MSISDN | Operator | Area |
|--------|----------|------|
| 9714499703 | Airtel | Surat |
| 8980261614 | Vi | Rajkot |
| 9877535365 | Jio | Surat |
| 9477523061 | BSNL | Kolkata |
