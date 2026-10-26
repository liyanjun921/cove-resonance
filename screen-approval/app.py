"""XLC consent-only screenshot bridge. Isolated from music and health services.

Never captures a device screen. A user selects, previews and explicitly uploads one image.
No server persistence survives a Render free-service restart; requests expire in 10 minutes.
"""
import asyncio
import base64
import hmac
import io
import json
import os
import secrets
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import uvicorn
import oauth
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner
from mcp.server.fastmcp import FastMCP
from mcp import types
from mcp.types import ImageContent, TextContent
from PIL import Image, ImageOps, UnidentifiedImageError
from pywebpush import WebPushException, webpush

BASE = Path(__file__).parent
OWNER_SECRET = os.getenv("SNAPSHOT_OWNER_SECRET", "")
MCP_SECRET = os.getenv("SNAPSHOT_MCP_TOKEN", "")
SESSION_SECRET = os.getenv("SNAPSHOT_SESSION_SECRET", "")
VAPID_PRIVATE = os.getenv("VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC = os.getenv("VAPID_PUBLIC_KEY", "")
VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", "")
ENABLED = all(len(s) >= 24 for s in (OWNER_SECRET, SESSION_SECRET))
LEGACY_MCP_ENABLED = len(MCP_SECRET) >= 24
signer = TimestampSigner(SESSION_SECRET) if SESSION_SECRET else None
mcp = FastMCP("XLC Screenshot Approval", stateless_http=True,
              json_response=True, streamable_http_path="/mcp")
LOCK = asyncio.Lock()
REQUESTS = {}
SUBSCRIPTIONS = {}
LOGIN_ATTEMPTS = {}
MAX_FILE_BYTES = 5 * 1024 * 1024
TTL_SECONDS = 600


@dataclass
class Snapshot:
    created: float
    reason: str
    state: str = "pending"
    path: Optional[str] = None
    ticket: Optional[str] = None
    ticket_expires: float = 0


def cleanup():
    now = time.time()
    for rid, item in list(REQUESTS.items()):
        if now - item.created >= TTL_SECONDS and item.state in ("pending", "fulfilled"):
            item.state = "expired"
            if item.path:
                Path(item.path).unlink(missing_ok=True)
                item.path = None
        if now - item.created > 3600:
            if item.path:
                Path(item.path).unlink(missing_ok=True)
            del REQUESTS[rid]
    for key, stamps in list(LOGIN_ATTEMPTS.items()):
        valid = [x for x in stamps if x > now - 900]
        if valid:
            LOGIN_ATTEMPTS[key] = valid
        else:
            del LOGIN_ATTEMPTS[key]


def status(item):
    return {"status": item.state,
            "expires_in_seconds": max(0, int(item.created + TTL_SECONDS - time.time()))}


def safe_id(request_id):
    return request_id if isinstance(request_id, str) and len(request_id) <= 128 else ""


def push_one(sub):
    return webpush(subscription_info=sub, data="",
                   vapid_private_key=VAPID_PRIVATE,
                   vapid_claims={"sub": VAPID_SUBJECT}, ttl=300)


async def notify_owner():
    if not (VAPID_PRIVATE and VAPID_PUBLIC and VAPID_SUBJECT):
        return
    for key, sub in list(SUBSCRIPTIONS.items()):
        try:
            await asyncio.wait_for(asyncio.to_thread(push_one, sub), timeout=6)
        except (WebPushException, TimeoutError, Exception):
            # No screenshot or reason is ever included in the notification.
            SUBSCRIPTIONS.pop(key, None)



@mcp.tool()
async def request_screen_snapshot(reason: str) -> dict:
    """Ask for a screenshot. This never captures, uploads, or reads anything.
    The user must manually choose an image and approve it in their PWA.
    Request expires in 10 minutes. Push notification contains no private data.
    """
    if not ENABLED:
        return {"status": "unavailable", "reason": "Owner setup not completed"}
    reason = reason.strip()
    if not (3 <= len(reason) <= 140):
        return {"status": "invalid_reason", "reason": "3–140 characters required"}
    async with LOCK:
        cleanup()
        if sum(x.state == "pending" for x in REQUESTS.values()) >= 3:
            return {"status": "rate_limited"}
        rid = secrets.token_urlsafe(24)
        REQUESTS[rid] = Snapshot(time.time(), reason)
    await notify_owner()
    return {"request_id": rid, "status": "pending", "expires_in_seconds": 600,
            "note": "Only the owner can approve and manually upload a screenshot."}


@mcp.tool()
async def get_screen_snapshot_status(request_id: str) -> dict:
    """Check if a previously requested screenshot was approved or expired.
    This never returns image data.
    """
    async with LOCK:
        cleanup()
        item = REQUESTS.get(safe_id(request_id))
        return {"request_id": request_id, **status(item)} if item else {
            "status": "not_found"}


@mcp.tool()
async def read_approved_screen_snapshot(request_id: str) -> list[TextContent | ImageContent]:
    """Read an explicitly approved screenshot once. Deletes image before returning.
    Repeated reads do not return the screenshot.
    """
    async with LOCK:
        cleanup()
        item = REQUESTS.get(safe_id(request_id))
        if not item:
            return [TextContent(type="text", text='{"status":"not_found"}')]
        if item.state != "fulfilled" or not item.path:
            return [TextContent(type="text", text=json.dumps(status(item)))]
        path = Path(item.path)
        try:
            contents = path.read_bytes()
        except FileNotFoundError:
            item.state = "expired"
            item.path = None
            return [TextContent(type="text", text='{"status":"expired"}')]
        path.unlink(missing_ok=True)
        item.path = None
        item.state = "viewed"
    return [
        TextContent(type="text", text=json.dumps({
            "status": "viewed", "request_id": request_id,
            "notice": "User selected and approved this image. No ongoing screen access exists."})),
        ImageContent(type="image", mimeType="image/jpeg",
                     data=base64.b64encode(contents).decode("ascii"))
    ]


# ChatGPT needs public tool discovery plus explicit OAuth security metadata.
# A transport-level 401 prevents tools/list from being discovered, so only tool
# invocation is protected and uses the MCP mcp/www_authenticate hint.
OAUTH_SCOPES = ["snapshot:request", "snapshot:read"]
OAUTH_SECURITY_SCHEMES = [{"type": "oauth2", "scopes": OAUTH_SCOPES}]
TOOL_ANNOTATIONS = {
    "request_screen_snapshot": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    "get_screen_snapshot_status": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    "read_approved_screen_snapshot": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
}


@mcp._mcp_server.list_tools()
async def _list_tools():
    return [
        types.Tool(
            name="request_screen_snapshot",
            title="Request a screenshot",
            description=("Ask the owner to manually select, preview and upload one screenshot. "
                         "This never captures the device screen automatically."),
            inputSchema={"type": "object", "properties": {"reason": {"type": "string", "minLength": 3, "maxLength": 140}},
                         "required": ["reason"], "additionalProperties": False},
            securitySchemes=OAUTH_SECURITY_SCHEMES,
            _meta={"securitySchemes": OAUTH_SECURITY_SCHEMES},
            annotations=TOOL_ANNOTATIONS["request_screen_snapshot"],
        ),
        types.Tool(
            name="get_screen_snapshot_status",
            title="Check screenshot request",
            description="Check whether an owner-approved screenshot request is pending, fulfilled, denied or expired.",
            inputSchema={"type": "object", "properties": {"request_id": {"type": "string", "maxLength": 128}},
                         "required": ["request_id"], "additionalProperties": False},
            securitySchemes=OAUTH_SECURITY_SCHEMES,
            _meta={"securitySchemes": OAUTH_SECURITY_SCHEMES},
            annotations=TOOL_ANNOTATIONS["get_screen_snapshot_status"],
        ),
        types.Tool(
            name="read_approved_screen_snapshot",
            title="Read approved screenshot",
            description="Read once the single screenshot the owner manually selected and explicitly uploaded.",
            inputSchema={"type": "object", "properties": {"request_id": {"type": "string", "maxLength": 128}},
                         "required": ["request_id"], "additionalProperties": False},
            securitySchemes=OAUTH_SECURITY_SCHEMES,
            _meta={"securitySchemes": OAUTH_SECURITY_SCHEMES},
            annotations=TOOL_ANNOTATIONS["read_approved_screen_snapshot"],
        ),
    ]


def _mcp_authorization_header():
    try:
        context = mcp._mcp_server.request_context
    except LookupError:
        return ""
    request = getattr(context, "request", None)
    headers = getattr(request, "headers", None)
    if headers is not None:
        try:
            value = headers.get("authorization") or headers.get("Authorization")
            if value:
                return str(value).strip()
        except Exception:
            pass
    scope = getattr(request, "scope", None)
    if isinstance(scope, dict):
        for key, value in scope.get("headers", []):
            key = key.decode("latin-1") if isinstance(key, (bytes, bytearray)) else str(key)
            if key.lower() == "authorization":
                return value.decode("latin-1") if isinstance(value, (bytes, bytearray)) else str(value)
    if isinstance(request, dict):
        return str(request.get("authorization") or request.get("Authorization") or "")
    return ""


def _mcp_authorized():
    header = _mcp_authorization_header()
    oauth_ok = oauth.authenticated(header)
    legacy_ok = bool(LEGACY_MCP_ENABLED) and hmac.compare_digest(
        header.encode(), ("Bearer " + MCP_SECRET).encode())
    return ENABLED and (oauth_ok or legacy_ok)


def _oauth_required_result():
    return types.ServerResult(types.CallToolResult(
        content=[TextContent(type="text", text="Authentication required. Connect your private screenshot service to ChatGPT first.")],
        _meta={"mcp/www_authenticate": [oauth.www_authenticate()]},
        isError=True,
    ))


def _tool_error(message):
    return types.ServerResult(types.CallToolResult(
        content=[TextContent(type="text", text=message)],
        isError=True,
    ))


async def _call_tool_request(req: types.CallToolRequest):
    if not _mcp_authorized():
        return _oauth_required_result()
    name = req.params.name
    arguments = req.params.arguments or {}
    try:
        if name == "request_screen_snapshot":
            result = await request_screen_snapshot(**arguments)
            return types.ServerResult(types.CallToolResult(
                content=[TextContent(type="text", text=json.dumps(result, ensure_ascii=False))],
                structuredContent=result,
            ))
        if name == "get_screen_snapshot_status":
            result = await get_screen_snapshot_status(**arguments)
            return types.ServerResult(types.CallToolResult(
                content=[TextContent(type="text", text=json.dumps(result, ensure_ascii=False))],
                structuredContent=result,
            ))
        if name == "read_approved_screen_snapshot":
            result = await read_approved_screen_snapshot(**arguments)
            return types.ServerResult(types.CallToolResult(content=result))
    except (TypeError, ValueError) as exc:
        return _tool_error("Invalid tool arguments: " + str(exc)[:200])
    return _tool_error("Unknown tool: " + str(name))


mcp._mcp_server.request_handlers[types.CallToolRequest] = _call_tool_request



def authenticated(scope):
    if not (ENABLED and signer):
        return False
    cookie_header = next((v for k, v in scope.get("headers", [])
                          if k.lower() == b"cookie"), b"").decode("latin1")
    cookies = {}
    for part in cookie_header.split(";"):
        if "=" in part:
            key, value = part.strip().split("=", 1)
            cookies[key] = value
    try:
        return signer.unsign(cookies.get("snapshot_session", ""), max_age=7 * 86400) == b"owner"
    except (BadSignature, SignatureExpired, TypeError):
        return False


def get_header(scope, name):
    return next((v for k, v in scope.get("headers", []) if k.lower() == name.lower().encode()), b"").decode("latin1")


def same_origin(scope):
    origin = get_header(scope, "origin")
    host = get_header(scope, "host")
    expected = os.getenv("SNAPSHOT_PUBLIC_ORIGIN", "").rstrip("/")
    return bool(origin) and (origin == expected if expected else
                             origin == "https://" + host or
                             origin == "http://localhost:" + host.split(":")[-1])


async def body_bytes(receive, maximum=MAX_FILE_BYTES + 4096):
    body = bytearray()
    while True:
        event = await receive()
        if event["type"] == "http.disconnect":
            raise ValueError("disconnected")
        body.extend(event.get("body", b""))
        if len(body) > maximum:
            raise ValueError("too_large")
        if not event.get("more_body", False):
            break
    return bytes(body)


async def reply(send, data, status_code=200, headers=None, content_type="application/json; charset=utf-8"):
    if isinstance(data, (dict, list)):
        data = json.dumps(data, ensure_ascii=False).encode()
    elif isinstance(data, str):
        data = data.encode()
    h = [(b"content-type", content_type.encode()), (b"cache-control", b"no-store"),
         (b"x-content-type-options", b"nosniff"),
         (b"referrer-policy", b"no-referrer"),
         (b"x-frame-options", b"DENY"),
         (b"content-security-policy",
          b"default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'")]
    if headers:
        h.extend(headers)
    await send({"type": "http.response.start", "status": status_code, "headers": h})
    await send({"type": "http.response.body", "body": data})


def render_jpeg(raw):
    if len(raw) > MAX_FILE_BYTES:
        raise ValueError("too_large")
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.verify()
        with Image.open(io.BytesIO(raw)) as image:
            image = ImageOps.exif_transpose(image)
            if image.width * image.height > 20_000_000:
                raise ValueError("too_large")
            image = image.convert("RGB")
            image.thumbnail((2200, 2200))
            out = io.BytesIO()
            image.save(out, format="JPEG", quality=83, optimize=True, exif=b"")
            result = out.getvalue()
            if len(result) > MAX_FILE_BYTES:
                raise ValueError("too_large")
            return result
    except (UnidentifiedImageError, OSError) as e:
        raise ValueError("invalid_image") from e


class ScreenshotGate:
    def __init__(self, mcp_app):
        self.mcp_app = mcp_app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            async def reap():
                while True:
                    await asyncio.sleep(15)
                    async with LOCK:
                        cleanup()
            task = asyncio.create_task(reap())
            try:
                return await self.mcp_app(scope, receive, send)
            finally:
                task.cancel()
        if scope["type"] != "http":
            return await self.mcp_app(scope, receive, send)
        path = scope.get("path", "")
        method = scope.get("method", "GET")
        if await oauth.route(scope, receive, send, reply):
            return
        if path == "/healthz":
            return await reply(send, {"ok": True, "ready": ENABLED,
                         "push_configured": bool(VAPID_PRIVATE and VAPID_PUBLIC and VAPID_SUBJECT)})
        if path in ("/", "/app") and method == "GET":
            return await reply(send, (BASE / "app.html").read_bytes(),
                               content_type="text/html; charset=utf-8")
        if path == "/app.js" and method == "GET":
            return await reply(send, (BASE / "app.js").read_bytes(),
                               content_type="text/javascript; charset=utf-8")
        if path == "/sw.js" and method == "GET":
            return await reply(send, (BASE / "sw.js").read_bytes(),
                               headers=[(b"service-worker-allowed", b"/")],
                               content_type="text/javascript; charset=utf-8")
        if path == "/manifest.webmanifest" and method == "GET":
            return await reply(send, {"name": "谢临川 · 截图查岗", "short_name": "截图查岗",
                         "start_url": "/app", "scope": "/", "display": "standalone",
                         "background_color": "#f4f7fb", "theme_color": "#dbe6ef"},
                               content_type="application/manifest+json")
        if path.startswith("/api/"):
            if path == "/api/login" and method == "POST":
                if not ENABLED:
                    return await reply(send, {"error": "owner_setup_required"}, 503)
                if not same_origin(scope):
                    return await reply(send, {"error": "origin_rejected"}, 403)
                ip = get_header(scope, "x-forwarded-for").split(",")[0].strip() or "unknown"
                cleanup()
                attempts = LOGIN_ATTEMPTS.setdefault(ip, [])
                if len(attempts) >= 8:
                    return await reply(send, {"error": "try_later"}, 429)
                try:
                    info = json.loads(await body_bytes(receive, 2048))
                    supplied = str(info.get("secret", ""))
                except (ValueError, json.JSONDecodeError):
                    return await reply(send, {"error": "invalid_request"}, 400)
                if not hmac.compare_digest(supplied, OWNER_SECRET):
                    attempts.append(time.time())
                    return await reply(send, {"error": "bad_secret"}, 403)
                LOGIN_ATTEMPTS.pop(ip, None)
                cookie = signer.sign(b"owner").decode()
                return await reply(send, {"ok": True}, headers=[
                    (b"set-cookie", ("snapshot_session=" + cookie +
                     "; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800").encode())])
            if not authenticated(scope):
                return await reply(send, {"error": "login_required"}, 401)
            if method == "POST" and (not same_origin(scope) or
                                      get_header(scope, "x-snapshot-action") != "1"):
                return await reply(send, {"error": "csrf_rejected"}, 403)
            if path == "/api/requests" and method == "GET":
                async with LOCK:
                    cleanup()
                    return await reply(send, {"requests": [
                        {"id": rid, "reason": item.reason, **status(item)}
                        for rid, item in REQUESTS.items() if item.state == "pending"]})
            if path == "/api/vapid" and method == "GET":
                return await reply(send, {"publicKey": VAPID_PUBLIC if VAPID_PRIVATE and VAPID_SUBJECT else ""})
            if path == "/api/subscribe" and method == "POST":
                try:
                    sub = json.loads(await body_bytes(receive, 5000))
                    endpoint = sub["endpoint"]
                    if not isinstance(endpoint, str) or not endpoint.startswith("https://") or \
                       not isinstance(sub.get("keys"), dict) or \
                       not sub["keys"].get("auth") or not sub["keys"].get("p256dh"):
                        raise ValueError()
                except (ValueError, KeyError, json.JSONDecodeError):
                    return await reply(send, {"error": "invalid_subscription"}, 400)
                SUBSCRIPTIONS[endpoint] = sub
                return await reply(send, {"ok": True})
            if path.startswith("/api/requests/"):
                segments = path.split("/")
                if len(segments) != 5:
                    return await reply(send, {"error": "not_found"}, 404)
                rid, op = segments[3], segments[4]
                async with LOCK:
                    cleanup()
                    item = REQUESTS.get(safe_id(rid))
                    if not item:
                        return await reply(send, {"error": "not_found"}, 404)
                    if op == "deny" and method == "POST":
                        if item.state != "pending":
                            return await reply(send, status(item), 409)
                        item.state = "denied"
                        item.ticket = None
                        return await reply(send, status(item))
                    if op == "prepare" and method == "POST":
                        if item.state != "pending":
                            return await reply(send, status(item), 409)
                        item.ticket = secrets.token_urlsafe(28)
                        item.ticket_expires = min(time.time() + 60, item.created + TTL_SECONDS)
                        return await reply(send, {"upload_ticket": item.ticket, "expires_in": 60})
                    if op == "upload" and method == "POST":
                        if item.state != "pending" or not item.ticket or \
                           time.time() >= item.ticket_expires or \
                           not hmac.compare_digest(
                               get_header(scope, "x-upload-ticket"), item.ticket):
                            return await reply(send, {"error": "invalid_or_expired_ticket"}, 409)
                        item.ticket = None
                        try:
                            raw = await body_bytes(receive)
                            if get_header(scope, "content-type").split(";")[0] != "image/jpeg":
                                raise ValueError("invalid_content_type")
                            sanitized = render_jpeg(raw)
                        except ValueError as exc:
                            return await reply(send, {"error": str(exc)}, 400)
                        fd, filename = tempfile.mkstemp(prefix="xlc-shot-", suffix=".jpg")
                        try:
                            with os.fdopen(fd, "wb") as f:
                                f.write(sanitized)
                            os.chmod(filename, 0o600)
                            item.path = filename
                            item.state = "fulfilled"
                        except Exception:
                            Path(filename).unlink(missing_ok=True)
                            raise
                        return await reply(send, {"ok": True, "status": "fulfilled"})
            return await reply(send, {"error": "not_found"}, 404)
        # Keep MCP discovery reachable without a token. ChatGPT must see
        # tool-level securitySchemes; protected calls return mcp/www_authenticate.
        return await self.mcp_app(scope, receive, send)


app = ScreenshotGate(mcp.streamable_http_app())

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")),
                access_log=False, workers=1)
