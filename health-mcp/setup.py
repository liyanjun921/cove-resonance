"""One-time, password-protected QR onboarding for Mi Fitness.

A successful scan stays in RAM for at most 10 minutes. The admin manually
stores the resulting secret in Render's protected MI_TOKEN_B64 environment
variable. Nothing is committed, logged, or publicly downloadable.
"""
import asyncio
import base64
import hmac
import json
import os
from pathlib import Path
import tempfile
import time
from urllib.parse import urlparse

from mi_fitness import MiHealthClient, XiaomiAuth
from token_codec import parse_token
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, PlainTextResponse
from starlette.routing import Route


STATE = {"phase": "idle"}
TASK = None
LOCK = asyncio.Lock()
TTL_SECONDS = 600
HEADERS = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
           "X-Content-Type-Options": "nosniff"}
PRIVATE_DATA = {"sleep", "heart_rate", "steps"}


def _configured() -> bool:
    return len(os.environ.get("HEALTH_SETUP_SECRET", "")) >= 24


def _authorized(request: Request) -> bool:
    if not _configured():
        return False
    actual = request.headers.get("x-health-setup-secret", "")
    expected = os.environ["HEALTH_SETUP_SECRET"]
    return hmac.compare_digest(actual, expected)


def _scrub_if_old() -> None:
    if STATE.get("phase") == "authorized" and time.monotonic() > STATE.get("expires", 0):
        STATE.clear()
        STATE["phase"] = "expired"
    if STATE.get("phase") in ("qr", "starting") and time.monotonic() > STATE.get("expires", 0):
        STATE.clear()
        STATE["phase"] = "expired"


def _validate_qr_image_url(url: str) -> str:
    p = urlparse(url)
    if p.scheme != "https" or not p.hostname:
        return ""
    # This URL is rendered only as a browser image. Never fetch it server-side.
    return url


async def _login_worker():
    global STATE
    token_path = None
    try:
        async def callback(qr_image_url: str, login_url: str) -> None:
            STATE.update(phase="qr",
                         qr_image_url=_validate_qr_image_url(qr_image_url),
                         login_url=login_url if login_url.startswith("https://") else "",
                         expires=time.monotonic() + 300)

        async with XiaomiAuth() as auth:
            await auth.login_qr(qr_callback=callback, max_wait=300)
            fd, token_path = tempfile.mkstemp(prefix="mi-setup-", suffix=".json")
            os.close(fd)
            os.chmod(token_path, 0o600)
            auth.save_token(token_path)

        raw = Path(token_path).read_bytes()
        token = json.loads(raw)
        if not isinstance(token, dict):
            raise RuntimeError("Invalid Xiaomi token structure")
        relatives_data = []
        async with MiHealthClient.from_token(token_path) as client:
            relatives = await client.get_relatives()
            for rel in relatives:
                uid = int(rel.relative_uid)
                try:
                    scopes = set(await client.get_shared_data_types(uid))
                    scope_list = sorted(scopes & PRIVATE_DATA)
                except Exception:
                    scope_list = []
                relatives_data.append({
                    "relative_uid": uid,
                    "shared": scope_list,
                    "all_requested_fields_shared": PRIVATE_DATA.issubset(scope_list),
                })

        STATE.clear()
        STATE.update(phase="authorized",
                     expires=time.monotonic() + TTL_SECONDS,
                     token_b64=base64.b64encode(raw).decode("ascii"),
                     relatives=relatives_data)
    except asyncio.CancelledError:
        STATE.clear()
        STATE["phase"] = "expired"
        raise
    except Exception as exc:
        # Do not print exception text: provider errors may contain account data.
        STATE.clear()
        STATE.update(phase="error", error_type=type(exc).__name__)
    finally:
        if token_path:
            Path(token_path).unlink(missing_ok=True)


async def setup_page(request: Request):
    if not _configured():
        return PlainTextResponse("Setup disabled. Set HEALTH_SETUP_SECRET first.",
                                 status_code=404, headers=HEADERS)
    html = Path(__file__).with_name("setup.html").read_text(encoding="utf-8")
    return HTMLResponse(html, headers={**HEADERS, "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"})


async def start(request: Request):
    global TASK
    if not _authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401, headers=HEADERS)
    async with LOCK:
        _scrub_if_old()
        if TASK and not TASK.done():
            return JSONResponse({"phase": STATE.get("phase", "starting")}, headers=HEADERS)
        STATE.clear()
        STATE.update(phase="starting", expires=time.monotonic() + 330)
        TASK = asyncio.create_task(_login_worker())
    return JSONResponse({"phase": "starting"}, headers=HEADERS)


async def status(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401, headers=HEADERS)
    _scrub_if_old()
    return JSONResponse({k: v for k, v in STATE.items() if k not in ("token_b64", "expires")},
                        headers=HEADERS)


async def export(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401, headers=HEADERS)
    _scrub_if_old()
    if STATE.get("phase") != "authorized":
        return JSONResponse({"error": "not_authorized"}, status_code=409, headers=HEADERS)
    return JSONResponse({"token_base64": STATE["token_b64"]}, headers=HEADERS)


async def forget(request: Request):
    global TASK
    if not _authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401, headers=HEADERS)
    async with LOCK:
        if TASK and not TASK.done():
            TASK.cancel()
        STATE.clear()
        STATE["phase"] = "idle"
    return JSONResponse({"ok": True}, headers=HEADERS)



async def check_data_state() -> dict:
    """Check real Xiaomi permissions and a synchronized daily summary.

    Return only boolean availability flags, never vitals, timestamps,
    account IDs, credentials, or raw exception messages.
    """
    encoded = os.environ.get("MI_TOKEN_B64", "").strip()
    relative = os.environ.get("MI_RELATIVE_UID", "").strip()
    if not encoded or not relative:
        return {"ok": False, "code": "configuration_missing"}
    if not relative.isdigit() or int(relative) <= 0:
        return {"ok": False, "code": "relative_uid_invalid"}

    # Accept the original QR export and common copy/paste wrapper formats.
    # Only reveal the *format category*, not the credential or its length.
    raw, token_code = parse_token(encoded)
    if raw is None:
        return {"ok": False, "code": token_code}

    fd, token_path = tempfile.mkstemp(prefix="mi-health-check-", suffix=".json")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        os.chmod(token_path, 0o600)
        async def fetch():
            async with MiHealthClient.from_token(token_path) as client:
                uid = int(relative)
                relatives = await client.get_relatives()
                if not any(int(r.relative_uid) == uid for r in relatives):
                    return {"ok": False, "code": "relative_not_found"}
                scopes = set(await client.get_shared_data_types(uid))
                shared = sorted(scopes & PRIVATE_DATA)
                missing = sorted(PRIVATE_DATA - scopes)
                # Do not infer missing permissions from an empty measurement.
                # If data isn't shared, we report that before making reads.
                if missing:
                    return {"ok": False, "code": "scopes_missing",
                            "shared": shared, "missing": missing}
                summary = await client.get_latest_daily_summary(uid)
                available = {
                    "sleep": summary.sleep is not None,
                    "heart_rate": summary.heart_rate is not None,
                    "steps": summary.steps is not None,
                }
                return {"ok": True, "code": "read_succeeded",
                        "shared": shared, "available": available}
        try:
            result = await asyncio.wait_for(fetch(), timeout=45)
        except TimeoutError:
            result = {"ok": False, "code": "provider_timeout"}
        except Exception as exc:
            # Report only an exception *class*, never provider messages:
            # they can contain tokens or sensitive account metadata.
            allow = {"TokenExpiredError", "AuthError", "APIError",
                     "DataNotSharedError", "DeviceUntrustedError",
                     "CaptchaRequiredError", "DataOutOfSharedTimeScopeError"}
            kind = type(exc).__name__
            result = {"ok": False, "code": kind if kind in allow else "provider_error"}
        return result
    finally:
        Path(token_path).unlink(missing_ok=True)


async def check_data(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401, headers=HEADERS)
    return JSONResponse(await check_data_state(), headers=HEADERS)


setup_app = Starlette(routes=[
    Route("/setup", setup_page, methods=["GET"]),
    Route("/setup/start", start, methods=["POST"]),
    Route("/setup/status", status, methods=["GET"]),
    Route("/setup/export", export, methods=["POST"]),
    Route("/setup/forget", forget, methods=["POST"]),
    Route("/setup/check-data", check_data, methods=["POST"]),
])
