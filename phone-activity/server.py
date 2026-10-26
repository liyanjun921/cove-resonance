"""Private iPhone App open/close event receiver.

A single-purpose consent-based activity service. It does not access iOS or the
contents of apps: it only accepts events sent by user-created Shortcuts.
Independent of the user's music, health, screenshot and other bridges.
"""
import hmac
import json
import os
import sqlite3
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

TOKEN = os.getenv("PHONE_ACTIVITY_TOKEN", "")
ENABLED = len(TOKEN) >= 32
DB_PATH = Path(os.getenv("PHONE_ACTIVITY_DB", "/tmp/xlc-phone-activity/events.sqlite3"))
RETENTION_SECONDS = 7 * 24 * 3600
LOCK = threading.RLock()
MAX_REQUEST_BYTES = 2048


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH, timeout=10) as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recorded_at INTEGER NOT NULL,
            app TEXT NOT NULL,
            event TEXT NOT NULL,
            device TEXT NOT NULL
        )""")
        conn.execute("CREATE INDEX IF NOT EXISTS activity_by_time ON activity(recorded_at)")


def prune(conn, now):
    conn.execute("DELETE FROM activity WHERE recorded_at < ?", (now - RETENTION_SECONDS,))


def write_event(payload):
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object")
    app = payload.get("app")
    event = payload.get("event")
    device = payload.get("device", "iphone")
    if not isinstance(app, str) or not (1 <= len(app.strip()) <= 60):
        raise ValueError("app must be 1–60 characters")
    if any(ord(ch) < 32 for ch in app):
        raise ValueError("app has invalid characters")
    if event not in ("open", "close"):
        raise ValueError("event must be open or close")
    if not isinstance(device, str) or not (1 <= len(device.strip()) <= 32) or any(ord(ch) < 32 for ch in device):
        raise ValueError("device must be 1–32 characters")
    app = app.strip()
    device = device.strip()
    now = int(time.time())
    with LOCK, sqlite3.connect(DB_PATH, timeout=10) as conn:
        prune(conn, now)
        recent = conn.execute(
            "SELECT recorded_at FROM activity WHERE app=? AND event=? AND device=? ORDER BY id DESC LIMIT 1",
            (app, event, device)).fetchone()
        if recent and now - recent[0] < 3:
            return {"ok": True, "recorded": False, "duplicate": True}
        day_count = conn.execute("SELECT COUNT(*) FROM activity WHERE recorded_at >= ?", (now - 86400,)).fetchone()[0]
        if day_count >= 1000:
            raise OverflowError("Daily event cap reached")
        conn.execute("INSERT INTO activity(recorded_at,app,event,device) VALUES (?,?,?,?)",
                     (now, app, event, device))
    return {"ok": True, "recorded": True, "received_at_utc": datetime.fromtimestamp(now, timezone.utc).isoformat()}


def read_events(limit=30):
    limit = min(100, max(1, int(limit)))
    now = int(time.time())
    with LOCK, sqlite3.connect(DB_PATH, timeout=10) as conn:
        prune(conn, now)
        rows = conn.execute("SELECT recorded_at,app,event,device FROM activity ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return {
            "ok": True,
            "coverage": "Events submitted by configured iOS Shortcuts only; not a complete screen-time log.",
            "retention_days": 7,
            "events": [
                {"at_utc": datetime.fromtimestamp(stamp, timezone.utc).isoformat(),
                 "app": app, "event": event, "device": device}
                for stamp, app, event, device in rows
            ],
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "PhoneActivity/0.1"
    sys_version = ""

    def log_message(self, format, *args):
        # Do not log tokens, app names, URLs or query strings in application logs.
        pass

    def send_json(self, status, value):
        raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def authorized(self):
        if not ENABLED:
            self.send_json(503, {"error": "owner_setup_required"})
            return False
        received = self.headers.get("X-Phone-Token", "")
        bearer = self.headers.get("Authorization", "")
        valid = hmac.compare_digest(received, TOKEN) or hmac.compare_digest(bearer, "Bearer " + TOKEN)
        if not valid:
            self.send_json(401, {"error": "authorization_required"})
        return valid

    def do_GET(self):
        route = urlsplit(self.path)
        if route.path == "/healthz":
            self.send_json(200, {"ok": True, "ready": ENABLED, "storage": "ephemeral_sqlite"})
            return
        if route.path != "/v1/activity":
            self.send_json(404, {"error": "not_found"})
            return
        if not self.authorized():
            return
        try:
            raw = parse_qs(route.query).get("limit", ["30"])[0]
            if len(raw) > 3:
                raise ValueError()
            limit = int(raw)
            if not 1 <= limit <= 100:
                raise ValueError()
        except (ValueError, TypeError):
            self.send_json(400, {"error": "invalid_limit"})
            return
        self.send_json(200, read_events(limit))

    def do_POST(self):
        route = urlsplit(self.path)
        if route.path != "/v1/activity":
            self.send_json(404, {"error": "not_found"})
            return
        if not self.authorized():
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not (1 <= length <= MAX_REQUEST_BYTES):
                self.send_json(413, {"error": "invalid_body_size"})
                return
            if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                self.send_json(415, {"error": "requires_json"})
                return
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            answer = write_event(data)
        except (ValueError, TypeError, UnicodeError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": "invalid_event", "detail": str(exc)[:110]})
            return
        except OverflowError:
            self.send_json(429, {"error": "too_many_events"})
            return
        self.send_json(200, answer)


if __name__ == "__main__":
    init_db()
    port = int(os.getenv("PORT", "10000"))
    print("Phone activity receiver ready (only event counts; no app content).", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
