"""OpenSky OAuth2 client credentials (token refresh)."""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network/"
    "protocol/openid-connect/token"
)
TOKEN_REFRESH_MARGIN = 30
TOKEN_TIMEOUT = 10
ROOT = Path(__file__).resolve().parent


def load_credentials() -> tuple[str, str] | None:
    client_id = os.environ.get("OPENSKY_CLIENT_ID", "").strip()
    client_secret = os.environ.get("OPENSKY_CLIENT_SECRET", "").strip()
    if client_id and client_secret:
        return client_id, client_secret

    path = ROOT / "credentials.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    client_id = (
        data.get("clientId")
        or data.get("client_id")
        or data.get("clientID")
        or ""
    ).strip()
    client_secret = (
        data.get("clientSecret")
        or data.get("client_secret")
        or ""
    ).strip()
    if client_id and client_secret:
        return client_id, client_secret
    return None


class TokenManager:
    def __init__(self, client_id: str, client_secret: str):
        self.client_id = client_id
        self.client_secret = client_secret
        self.token: str | None = None
        self.expires_at: datetime | None = None
        self._lock = threading.Lock()

    def headers(self) -> dict[str, str]:
        try:
            return {"Authorization": f"Bearer {self.get_token()}"}
        except Exception:  # noqa: BLE001
            return {}

    def get_token(self) -> str:
        with self._lock:
            if (
                self.token
                and self.expires_at
                and datetime.now() < self.expires_at
            ):
                return self.token
            return self._refresh()

    def _refresh(self) -> str:
        body = urllib.parse.urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            }
        ).encode()
        req = urllib.request.Request(TOKEN_URL, data=body, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        with urllib.request.urlopen(req, timeout=TOKEN_TIMEOUT) as resp:
            data = json.loads(resp.read().decode())
        self.token = data["access_token"]
        expires_in = int(data.get("expires_in", 1800))
        self.expires_at = datetime.now() + timedelta(
            seconds=expires_in - TOKEN_REFRESH_MARGIN
        )
        return self.token


def create_token_manager() -> TokenManager | None:
    creds = load_credentials()
    if not creds:
        return None
    return TokenManager(creds[0], creds[1])
