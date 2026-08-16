"""Access control — role-based users, PBKDF2 password hashing, signed session tokens.

Session tokens are self-contained HMAC-SHA256 signed blobs (no third-party deps).
User store lives in ``backend/users.json``; the signing secret in
``backend/.auth_secret``. Both are created on first run and git-ignored.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

BACKEND_DIR = Path(__file__).resolve().parent
USERS_FILE = BACKEND_DIR / "users.json"
SECRET_FILE = BACKEND_DIR / ".auth_secret"

ROLES = ("admin", "analyst")
TOKEN_TTL_HOURS = 8
MAX_ATTEMPTS = 5
LOCKOUT_SECONDS = 300

PBKDF2_ITER = 260_000

_bearer = HTTPBearer(auto_error=False)

# --------------------------------------------------------------------------
# Signing secret
# --------------------------------------------------------------------------


def _load_secret() -> bytes:
    if SECRET_FILE.exists():
        return SECRET_FILE.read_bytes().strip()
    secret = secrets.token_hex(32).encode()
    SECRET_FILE.write_bytes(secret + b"\n")
    try:
        os_chmod_600()
    except Exception:
        pass
    return secret


def os_chmod_600() -> None:
    try:
        import os

        os.chmod(SECRET_FILE, 0o600)
        os.chmod(USERS_FILE, 0o600) if USERS_FILE.exists() else None
    except OSError:
        pass


_SECRET = _load_secret()

# --------------------------------------------------------------------------
# Password hashing — PBKDF2-HMAC-SHA256 with per-user salt
# --------------------------------------------------------------------------


def hash_password(password: str, salt: Optional[str] = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ITER)
    return dk.hex(), salt


def verify_password(password: str, salt: str, expected_hex: str) -> bool:
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ITER)
    return hmac.compare_digest(dk.hex(), expected_hex)


# --------------------------------------------------------------------------
# Signed session tokens
# --------------------------------------------------------------------------


def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def create_token(username: str, role: str, ttl_hours: int = TOKEN_TTL_HOURS) -> str:
    payload = {
        "sub": username,
        "role": role,
        "iat": int(time.time()),
        "exp": int(time.time()) + ttl_hours * 3600,
        "jti": secrets.token_hex(6),
    }
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode())
    sig = _b64e(hmac.new(_SECRET, body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_token(token: str) -> Optional[dict]:
    try:
        body, sig = token.split(".", 1)
        expected = _b64e(hmac.new(_SECRET, body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(_b64d(body))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        if "sub" not in payload or "role" not in payload:
            return None
        return payload
    except Exception:
        return None


# --------------------------------------------------------------------------
# User store
# --------------------------------------------------------------------------

_lock = threading.Lock()
_failed: dict[str, list[float]] = {}  # username -> [failure timestamps]

_user_cache: dict[str, dict] = {}


def _persist(users: dict) -> None:
    data = {"users": {u: dict(info) for u, info in users.items()}}
    USERS_FILE.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def load_users() -> dict[str, dict]:
    """Load user store, seeding the bootstrap admin on first run."""
    global _user_cache
    if _user_cache:
        return _user_cache
    users: dict[str, dict] = {}
    if USERS_FILE.exists():
        try:
            raw = json.loads(USERS_FILE.read_text(encoding="utf-8"))
            users = raw.get("users", {})
        except (json.JSONDecodeError, OSError):
            users = {}
    seeded = False
    if "admin" not in users:
        hex_hash, salt = hash_password("admin123")
        users["admin"] = {
            "password": hex_hash,
            "salt": salt,
            "role": "admin",
            "must_change_password": True,
            "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "created_by": "system",
        }
        seeded = True
    if "analyst" not in users:
        hex_hash, salt = hash_password("analyst123")
        users["analyst"] = {
            "password": hex_hash,
            "salt": salt,
            "role": "analyst",
            "must_change_password": True,
            "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "created_by": "system",
        }
        seeded = True
    if seeded:
        _persist(users)
    _user_cache = users
    return users


def save_users() -> None:
    with _lock:
        _persist(_user_cache)


def get_user(username: str) -> Optional[dict]:
    load_users()
    return _user_cache.get(username)


def add_user(username: str, password: str, role: str, created_by: str = "system") -> None:
    with _lock:
        load_users()
        if username in _user_cache:
            raise ValueError(f"user already exists: {username}")
        hex_hash, salt = hash_password(password)
        _user_cache[username] = {
            "password": hex_hash,
            "salt": salt,
            "role": role,
            "must_change_password": True,
            "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "created_by": created_by,
        }
        _persist(_user_cache)


def set_user_field(username: str, **fields) -> None:
    with _lock:
        load_users()
        user = _user_cache.get(username)
        if not user:
            raise KeyError(username)
        user.update(fields)
        _persist(_user_cache)


# --------------------------------------------------------------------------
# Login / lockout
# --------------------------------------------------------------------------


def _is_locked(username: str) -> bool:
    now = time.time()
    stamps = [t for t in _failed.get(username, []) if now - t < LOCKOUT_SECONDS]
    if stamps:
        _failed[username] = stamps
    return len(stamps) >= MAX_ATTEMPTS


def _record_failure(username: str) -> None:
    _failed.setdefault(username, []).append(time.time())


def clear_failures(username: str) -> None:
    _failed.pop(username, None)


def authenticate(username: str, password: str) -> Optional[dict]:
    """Return the user record on success, else None. Applies brute-force lockout."""
    user = get_user(username)
    if not user:
        # Burn a hash comparison to keep timing uniform-ish
        hash_password(password)
        return None
    if _is_locked(username):
        return None
    if not verify_password(password, user["salt"], user["password"]):
        _record_failure(username)
        return None
    clear_failures(username)
    return user


def lockout_seconds_left(username: str) -> int:
    now = time.time()
    stamps = [t for t in _failed.get(username, []) if now - t < LOCKOUT_SECONDS]
    if len(stamps) < MAX_ATTEMPTS:
        return 0
    return max(0, int(stamps[0] + LOCKOUT_SECONDS - now))


# --------------------------------------------------------------------------
# FastAPI dependencies
# --------------------------------------------------------------------------


def _parse_token(credentials: Optional[HTTPAuthorizationCredentials]) -> Optional[dict]:
    if not credentials or not credentials.credentials:
        return None
    return verify_token(credentials.credentials)


def current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> dict:
    """Validate the session token only — does NOT enforce must_change_password."""
    payload = _parse_token(credentials)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = get_user(payload["sub"])
    if not user:
        raise HTTPException(status_code=401, detail="Account no longer exists")
    return {
        "username": payload["sub"],
        "role": payload["role"],
        "record": user,
    }


def require_active(user: dict = Depends(current_user)) -> dict:
    """Gate every data endpoint behind the forced-password-change step."""
    if user["record"].get("must_change_password"):
        raise HTTPException(
            status_code=403,
            detail="must_change_password",
            headers={"X-Auth-Flow": "change-password"},
        )
    return user


def require_role(*roles: str):
    def dep(user: dict = Depends(current_user)) -> dict:
        if user["record"].get("must_change_password"):
            raise HTTPException(
                status_code=403,
                detail="must_change_password",
                headers={"X-Auth-Flow": "change-password"},
            )
        if user["role"] not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires role: {', '.join(roles)}",
            )
        return user

    return dep
