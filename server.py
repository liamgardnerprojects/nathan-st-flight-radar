#!/usr/bin/env python3
"""Serve the flight radar UI and proxy OpenSky (avoids browser CORS limits)."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from opensky_auth import create_token_manager

ROOT = os.path.dirname(os.path.abspath(__file__))
OPENSKY = "https://opensky-network.org/api"
ADSBDB = "https://api.adsbdb.com/v0/aircraft"
HEXDB = "https://hexdb.io/api/v1/aircraft"
PORT = int(os.environ.get("PORT", "8765"))

# Credits per day (states bucket) — see OpenSky API docs
CREDITS_ANONYMOUS = 400
CREDITS_REGISTERED = 4_000
# Active 07:00–22:59; standby 23:00–06:59 (8 h)
ACTIVE_MINUTES_PER_DAY = 16 * 60
PREFERRED_REFRESH_AUTHENTICATED = 15  # seconds
FETCH_TIMEOUT = 20  # seconds per attempt
FETCH_RETRIES = 3


def recommended_refresh_sec(*, authenticated: bool) -> int:
    credits = CREDITS_REGISTERED if authenticated else CREDITS_ANONYMOUS
    active_sec = ACTIVE_MINUTES_PER_DAY * 60
    budget_sec = active_sec // credits
    if authenticated:
        return min(PREFERRED_REFRESH_AUTHENTICATED, max(10, budget_sec))
    return max(10, budget_sec)


TOKENS = create_token_manager()
REFRESH_SEC = recommended_refresh_sec(authenticated=TOKENS is not None)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/status":
            self._json_response(
                200,
                {
                    "openskyAuthenticated": TOKENS is not None,
                    "dailyCredits": (
                        CREDITS_REGISTERED if TOKENS else CREDITS_ANONYMOUS
                    ),
                    "refreshSec": REFRESH_SEC,
                },
            )
            return
        if parsed.path == "/api/states":
            self._proxy_states(parsed.query)
            return
        if parsed.path.startswith("/api/aircraft/"):
            icao = parsed.path.split("/api/aircraft/", 1)[1].strip().lower()
            if icao and all(c in "0123456789abcdef" for c in icao):
                self._proxy_metadata(icao)
                return
        if parsed.path.startswith("/api/flights/"):
            icao = parsed.path.split("/api/flights/", 1)[1].strip().lower()
            if icao and all(c in "0123456789abcdef" for c in icao):
                self._proxy_flights(icao, parsed.query)
                return
        super().do_GET()

    def _json_response(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy_states(self, query: str):
        upstream = f"{OPENSKY}/states/all"
        if query:
            upstream += "?" + query
        self._proxy_json(upstream)

    def _proxy_metadata(self, icao: str):
        opensky_url = f"{OPENSKY}/metadata/aircraft/icao24/{icao}"
        try:
            code, body = self._fetch(upstream=opensky_url)
            if code == 200 and body:
                self._send_raw(200, body, "application/json")
                return
        except Exception:  # noqa: BLE001
            pass
        for fallback in (
            lambda: self._metadata_from_adsbdb(icao),
            lambda: self._metadata_from_hexdb(icao),
        ):
            try:
                payload = fallback()
                if payload:
                    self._json_response(200, payload)
                    return
            except Exception:  # noqa: BLE001
                continue
        self._json_response(404, {"error": "aircraft metadata not found"})

    def _metadata_from_adsbdb(self, icao: str) -> dict | None:
        code, body = self._fetch(f"{ADSBDB}/{icao.upper()}")
        if code != 200 or not body:
            return None
        data = json.loads(body)
        ac = (data.get("response") or {}).get("aircraft")
        if not ac:
            return None
        icao_type = (ac.get("icao_type") or "").strip()
        manufacturer = (ac.get("manufacturer") or "").strip()
        model = (ac.get("type") or "").strip()
        return {
            "icao24": icao.lower(),
            "registration": ac.get("registration"),
            "typecode": icao_type or None,
            "manufacturername": manufacturer or None,
            "model": model or None,
            "operator": ac.get("registered_owner"),
            "operatorcallsign": ac.get("registered_owner_operator_flag_code"),
            "source": "adsbdb",
        }

    def _metadata_from_hexdb(self, icao: str) -> dict | None:
        code, body = self._fetch(f"{HEXDB}/{icao.upper()}")
        if code != 200 or not body:
            return None
        ac = json.loads(body)
        if ac.get("status") == "404" or ac.get("error"):
            return None
        icao_type = (ac.get("ICAOTypeCode") or "").strip()
        manufacturer = (ac.get("Manufacturer") or "").strip()
        model = (ac.get("Type") or "").strip()
        return {
            "icao24": icao.lower(),
            "registration": ac.get("Registration"),
            "typecode": icao_type or None,
            "manufacturername": manufacturer or None,
            "model": model or None,
            "operator": ac.get("RegisteredOwners"),
            "operatorcallsign": ac.get("OperatorFlagCode"),
            "source": "hexdb",
        }

    def _proxy_flights(self, icao: str, query: str):
        upstream = f"{OPENSKY}/flights/aircraft?icao24={icao}"
        if query:
            upstream += "&" + query.lstrip("?")
        self._proxy_json(upstream)

    def _auth_headers(self) -> dict[str, str]:
        headers = {"User-Agent": "NathanStFlightRadar/1.0 (home use)"}
        if TOKENS:
            headers.update(TOKENS.headers())
        return headers

    def _fetch(self, upstream: str) -> tuple[int, bytes]:
        last_exc: Exception | None = None
        for attempt in range(FETCH_RETRIES):
            req = urllib.request.Request(upstream, headers=self._auth_headers())
            try:
                with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
                    return resp.status, resp.read()
            except urllib.error.HTTPError as exc:
                return exc.code, exc.read()
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_exc = exc
                if attempt + 1 < FETCH_RETRIES:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise last_exc from exc
        raise RuntimeError("unreachable")  # pragma: no cover

    def _send_raw(self, code: int, body: bytes, content_type: str):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy_json(self, url: str):
        try:
            code, body = self._fetch(url)
            if code == 200:
                self._send_raw(200, body, "application/json")
                return
            self._send_raw(
                code,
                body or b'{"error":"upstream http error"}',
                "application/json",
            )
        except Exception as exc:  # noqa: BLE001
            payload = json.dumps({"error": str(exc)}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)

    def log_message(self, fmt, *args):
        if args and str(args[0]).startswith("GET /api/"):
            return
        super().log_message(fmt, *args)


def _warm_opensky() -> None:
    if not TOKENS:
        return
    try:
        TOKENS.get_token()
        print("OpenSky token ready.")
    except Exception as exc:  # noqa: BLE001
        print(f"OpenSky token warm-up failed: {exc}")


def main():
    _warm_opensky()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Nathan St Flight Radar — http://0.0.0.0:{PORT}")
    print("On iPad (same Wi‑Fi): http://<this-mac-ip>:{PORT}")
    if TOKENS:
        print(
            f"OpenSky: authenticated · {CREDITS_REGISTERED} credits/day · "
            f"scan every {REFRESH_SEC}s"
        )
    else:
        print(
            "OpenSky: anonymous (add credentials.json for your account) · "
            f"scan every {REFRESH_SEC}s"
        )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
