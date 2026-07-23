#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/backend"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
  source .venv/bin/activate
  pip install -r requirements.txt
else
  source .venv/bin/activate
fi
echo "E-Rakshak Pinpoint → http://0.0.0.0:8080"
exec uvicorn app:app --host 0.0.0.0 --port 8080 --reload
