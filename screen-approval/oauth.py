"""Small single-owner OAuth 2.1 authorization server for the consent-only MCP.

OAuth metadata + dynamic public client registration + PKCE S256.
This grants only access to the existing owner-approved snapshot MCP.
No screenshot is ever delivered by an OAuth route.
"""
import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import time
from urllib.parse import parse_qs, urlencode, urlsplit

ORIGIN = os.getenv("SNAPSHOT_PUBLIC_ORIGIN", "https://xlc-consent-snapshot.onrender.com").rstrip("/")
RESOURCE = ORIGIN + "/mcp"
SECRET = os.getenv("SNAPSHOT_OAUTH_SIGNING_SECRET") or os.getenv("SNAPSHOT_SESSION_SECRET", "")
OWNER_SECRET = os.getenv("SNAPSHOT_OWNER_SECRET", "")
SCOPES = "snapshot:request snapshot:read"
CODES = {}
ATTEMPTS = {}
MAX_REQUEST = 12000
PKCE_RE = re.compile(r"^[A-Za-z0-9_-]{43,128}$")


def enc(raw: bytes):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def dec(raw: str):
    return base64.urlsafe_b64decode(raw + "=" * ((-len(raw)) % 4))


def sign(payload: dict):
    raw = enc(json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode())
    sig = enc(hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).digest())
    return raw + "." + sig


def verify(token: str, kind: str, ttl: int | None = None):
    if not SECRET or len(token) > 8192:
        return None
    try:
        raw, supplied = token.split(".", 1)
        if not hmac.compare_digest(supplied, enc(hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).digest())):
            return None
        data = json.loads(dec(raw))
        now = time.time()
        if data.get("kind") != kind or data.get("exp", 0) <= now:
            return None
        if ttl is not None and now - data.get("iat", 0) > ttl:
            return None
        return data
    except (ValueError, TypeError, KeyError, UnicodeError):
        return None


def header(scope, name):
    key = name.lower().encode()
    return next((v for k, v in scope.get("headers", []) if k.lower() == key), b"").decode("latin1")


def redirect_valid(uri):
    try:
        u = urlsplit(uri)
    except (ValueError, TypeError):
        return False
    return (
        u.scheme == "https"
        and u.hostname in {"chatgpt.com", "chat.openai.com"}
        and not u.username and not u.password and not u.fragment
        and (u.port is None or u.port == 443)
        and bool(u.path.startswith("/"))
        and len(uri) < 2048
    )


def client_info(client_id):
    value = str(client_id)
    if not value.startswith("snap_"):
        return None
    info = verify(value[5:], "client")
    if not info:
        return None
    return info


def metadata(path):
    if path in ("/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"):
        return {
            "resource": RESOURCE,
            "authorization_servers": [ORIGIN],
            "bearer_methods_supported": ["header"],
            "scopes_supported": SCOPES.split(),
        }
    return {
        "issuer": ORIGIN,
        "authorization_endpoint": ORIGIN + "/oauth/authorize",
        "token_endpoint": ORIGIN + "/oauth/token",
        "registration_endpoint": ORIGIN + "/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": ["none"],
        "code_challenge_methods_supported": ["S256"],
        "scopes_supported": SCOPES.split(),
    }


def www_authenticate():
    # Resource is /mcp, so RFC 9728 uses path-specific metadata discovery.
    return 'Bearer resource_metadata="' + ORIGIN + '/.well-known/oauth-protected-resource/mcp", scope="' + SCOPES + '"'


def authenticated(bearer):
    if not bearer or not bearer.startswith("Bearer "):
        return False
    token = bearer[7:]
    info = verify(token, "access")
    return bool(info and info.get("aud") == RESOURCE and info.get("iss") == ORIGIN and info.get("scope") == SCOPES)


async def parse_form(receive):
    chunks = bytearray()
    while True:
        e = await receive()
        if e["type"] == "http.disconnect":
            return None
        chunks.extend(e.get("body", b""))
        if len(chunks) > MAX_REQUEST:
            return None
        if not e.get("more_body", False):
            break
    try:
        return {k: v[0] for k, v in parse_qs(chunks.decode(), keep_blank_values=True).items()}
    except UnicodeDecodeError:
        return None


async def parse_json(receive):
    chunks = bytearray()
    while True:
        e = await receive()
        if e["type"] == "http.disconnect":
            return None
        chunks.extend(e.get("body", b""))
        if len(chunks) > MAX_REQUEST:
            return None
        if not e.get("more_body", False):
            break
    try:
        return json.loads(chunks)
    except (ValueError, UnicodeDecodeError):
        return None


def limited(ip):
    now = time.time()
    ATTEMPTS[ip] = [t for t in ATTEMPTS.get(ip, []) if t > now - 900]
    return len(ATTEMPTS[ip]) >= 8


def prune():
    now = time.time()
    for code, details in list(CODES.items()):
        if details["exp"] < now:
            CODES.pop(code, None)


def auth_request(params):
    client = client_info(params.get("client_id", ""))
    redirect_uri = params.get("redirect_uri", "")
    if not client or redirect_uri not in client.get("redirect_uris", []):
        return None
    challenge = params.get("code_challenge", "")
    if (params.get("response_type") != "code"
        or params.get("code_challenge_method") != "S256"
        or not PKCE_RE.fullmatch(challenge)
        or len(params.get("state", "")) > 2048
        or params.get("resource", RESOURCE) != RESOURCE):
        return None
    scopes = set(params.get("scope", SCOPES).split())
    if not scopes or not scopes.issubset(set(SCOPES.split())):
        return None
    return {
        "client_id": params["client_id"], "redirect_uri": redirect_uri,
        "challenge": challenge, "state": params.get("state", ""),
        "scope": SCOPES,
    }


def login_html(ticket):
    return (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="referrer" content="no-referrer">'
        '<title>授权截图查岗</title>'
        '<style>body{background:linear-gradient(125deg,#eef6ff,#fceff7);font-family:-apple-system,sans-serif;'
        'color:#3d4d66;min-height:100vh;display:grid;place-items:center;margin:0}'
        'main{max-width:440px;margin:20px;padding:28px;background:#ffffffcf;border:1px solid white;border-radius:25px}'
        'h2{font-size:24px}p{line-height:1.8;color:#697b8f;font-size:14px}'
        'input,button{font:inherit;width:100%;padding:13px;margin:12px 0;box-sizing:border-box;border-radius:12px}'
        'input{border:1px solid #cbd8e7}button{background:#7189a8;border:0;color:white;font-weight:650}'
        '</style></head><body><main><h2>谢临川 · 截图查岗</h2>'
        '<p>ChatGPT 请求连接你的私人截图授权服务。授权后它只能提出申请、查看申请状态，'
        '并读取你<strong>亲自选图且确认上传</strong>的一张截图。它不能自动截屏。</p>'
        '<form method="POST" action="/oauth/authorize">'
        '<input type="hidden" name="ticket" value="' + html.escape(ticket, quote=True) + '">'
        '<label for="key">私人服务登录密码</label>'
        '<input type="password" id="key" name="owner_secret" required autocomplete="current-password">'
        '<button type="submit">我同意连接 ChatGPT</button>'
        '</form><p>不想授权？直接关闭此页面即可。密码只提交给你自己的 Render 服务。</p>'
        '</main></body></html>'
    )


async def route(scope, receive, send, reply):
    """Return True if an OAuth route was handled."""
    path = scope.get("path", "")
    method = scope.get("method", "")
    if path in ("/.well-known/oauth-protected-resource",
                "/.well-known/oauth-protected-resource/mcp",
                "/.well-known/oauth-authorization-server") and method == "GET":
        await reply(send, metadata(path))
        return True
    if path == "/oauth/register" and method == "POST":
        if not SECRET:
            await reply(send, {"error": "server_unavailable"}, 503)
            return True
        if header(scope, "content-type").split(";")[0] != "application/json":
            await reply(send, {"error":"invalid_client_metadata"},400)
            return True
        params = await parse_json(receive)
        if not isinstance(params, dict):
            await reply(send, {"error":"invalid_client_metadata"},400)
            return True
        uris = params.get("redirect_uris", [])
        if not isinstance(uris, list) or not (1 <= len(uris) <= 8) or not all(isinstance(uri,str) and redirect_valid(uri) for uri in uris):
            await reply(send, {"error":"invalid_redirect_uri"},400)
            return True
        if params.get("token_endpoint_auth_method", "none") != "none":
            await reply(send, {"error":"invalid_client_metadata"},400)
            return True
        now = int(time.time())
        cid = "snap_" + sign({"kind":"client", "redirect_uris": uris,
                              "iat":now, "exp":now + 365 * 86400, "nonce":secrets.token_urlsafe(8)})
        await reply(send, {
            "client_id": cid, "client_id_issued_at": now,
            "client_secret_expires_at": 0, "redirect_uris": uris,
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code","refresh_token"],
            "response_types": ["code"]},201)
        return True
    if path == "/oauth/authorize":
        if method == "GET":
            qs = scope.get("query_string", b"").decode("utf-8", errors="replace")
            params = {k:v[0] for k,v in parse_qs(qs, keep_blank_values=True).items()}
            data = auth_request(params)
            if not data or not SECRET or not OWNER_SECRET:
                await reply(send, {"error":"invalid_authorization_request"},400)
                return True
            now = int(time.time())
            ticket = sign({"kind":"login","iat":now,"exp":now+300,"request":data})
            await reply(send,login_html(ticket),content_type="text/html; charset=utf-8")
            return True
        if method == "POST":
            if header(scope,"origin") != ORIGIN or header(scope,"content-type").split(";")[0] != "application/x-www-form-urlencoded":
                await reply(send, {"error":"invalid_request"},403)
                return True
            form = await parse_form(receive)
            ip = header(scope,"x-forwarded-for").split(",")[0].strip() or "unknown"
            if not form or limited(ip):
                await reply(send, {"error":"try_later"},429)
                return True
            ticket = verify(form.get("ticket",""),"login",300)
            data = ticket.get("request") if ticket else None
            if (not data or not auth_request({"client_id":data["client_id"],
                                             "redirect_uri":data["redirect_uri"],
                                             "response_type":"code","code_challenge":data["challenge"],
                                             "code_challenge_method":"S256",
                                             "state":data["state"],"scope":data["scope"]})
                or not hmac.compare_digest(str(form.get("owner_secret","")),OWNER_SECRET)):
                ATTEMPTS.setdefault(ip,[]).append(time.time())
                await reply(send,{"error":"invalid_credentials_or_expired_request"},403)
                return True
            ATTEMPTS.pop(ip,None)
            prune()
            code=secrets.token_urlsafe(32)
            CODES[code]={**data,"exp":time.time()+120}
            query={"code":code}
            if data["state"]:
                query["state"]=data["state"]
            connector="&" if "?" in data["redirect_uri"] else "?"
            location = data["redirect_uri"] + connector + urlencode(query)
            await reply(send,b"",status_code=303,headers=[(b"location",location.encode())],
                        content_type="text/plain")
            return True
    if path == "/oauth/token" and method == "POST":
        if header(scope,"content-type").split(";")[0] != "application/x-www-form-urlencoded":
            await reply(send,{"error":"invalid_request"},400)
            return True
        form = await parse_form(receive)
        if form is None:
            await reply(send,{"error":"invalid_request"},400)
            return True
        grant = form.get("grant_type")
        client_id = form.get("client_id","")
        if not client_info(client_id):
            await reply(send,{"error":"invalid_client"},401)
            return True
        now = int(time.time())
        if grant == "authorization_code":
            prune()
            code=form.get("code","")
            data=CODES.pop(code,None)
            verifier=form.get("code_verifier","")
            if (not data or data["exp"] < now or data["client_id"] != client_id
                or data["redirect_uri"] != form.get("redirect_uri","")
                or not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}",verifier)
                or enc(hashlib.sha256(verifier.encode()).digest()) != data["challenge"]):
                await reply(send,{"error":"invalid_grant"},400)
                return True
        elif grant == "refresh_token":
            refresh=verify(form.get("refresh_token",""),"refresh")
            if not refresh or refresh.get("client_id") != client_id:
                await reply(send,{"error":"invalid_grant"},400)
                return True
        else:
            await reply(send,{"error":"unsupported_grant_type"},400)
            return True
        claims={"sub":"owner","client_id":client_id,"iss":ORIGIN,
                "aud":RESOURCE,"scope":SCOPES,"iat":now}
        access=sign({**claims,"kind":"access","exp":now+3600})
        refresh=sign({**claims,"kind":"refresh","exp":now+30*86400})
        await reply(send,{"access_token":access,"token_type":"Bearer",
                          "expires_in":3600,"refresh_token":refresh,"scope":SCOPES})
        return True
    return False
