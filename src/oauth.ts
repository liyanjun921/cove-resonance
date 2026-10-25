import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sealPendingRequest, unsealPendingRequest } from "./oauthPending.js";

type RegisteredClient = { redirect_uris: string[]; expires: number };
type PendingRequest = {
  clientId: string; redirectUri: string; challenge: string;
  state: string; resource: string; created: number;
};
type AuthorizationCode = PendingRequest;
type AccessGrant = { clientId: string; resource: string; expires: number };
type RefreshGrant = { clientId: string; resource: string; expires: number };
type OAuthConfig = { origin: string; ownerPassword: string; signingSecret: string };

const MAX_BODY = 16 * 1024;
const AUTH_REQUEST_LIFETIME = 20 * 60_000;
const ACCESS_LIFETIME = 60 * 60_000;
const REFRESH_LIFETIME = 30 * 24 * 60 * 60_000;
const AUTH_CODE_LIFETIME = 2 * 60_000;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

function equal(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function json(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "pragma": "no-cache", ...headers });
  res.end(JSON.stringify(data));
}

function bad(res: ServerResponse, error: string, status = 400) {
  json(res, status, { error });
}

async function formData(req: IncomingMessage): Promise<URLSearchParams> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_BODY) throw new Error("body_too_large");
    parts.push(part);
  }
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") throw new Error("expected_form");
  return new URLSearchParams(Buffer.concat(parts).toString("utf8"));
}

async function registrationJson(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_BODY) throw new Error("body_too_large");
    parts.push(part);
  }
  if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/json") {
    throw new Error("expected_json");
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

export function validateRedirect(uri: string): boolean {
  if (typeof uri !== "string" || uri.length < 10 || uri.length > 2048) return false;
  try {
    const u = new URL(uri);
    if (u.username || u.password || u.hash || !u.hostname) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export class PersonalOAuthServer {
  private readonly clientsKey: Buffer;
  private readonly ownerPassword: string;
  private readonly origin: string;
  private readonly signingSecret: string;
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly usedConsentRequests = new Map<string, number>();
  private readonly access = new Map<string, AccessGrant>();
  private readonly refresh = new Map<string, RefreshGrant>();
  private failedLogins = 0;
  private lockedUntil = 0;
  readonly enabled: boolean;

  constructor(config: OAuthConfig) {
    this.origin = config.origin.replace(/\/$/, "");
    this.ownerPassword = config.ownerPassword;
    this.clientsKey = Buffer.from(config.signingSecret);
    this.signingSecret = config.signingSecret;
    this.enabled = this.origin.startsWith("https://") &&
      config.ownerPassword.length >= 16 && config.signingSecret.length >= 32;
  }

  private sign(message: string): string {
    return createHmac("sha256", this.clientsKey).update(message).digest("base64url");
  }

  private clientFromId(clientId: string): RegisteredClient | null {
    const parts = clientId.split(".");
    if (parts.length !== 3 || parts[0] !== "cove" || clientId.length > 9000) return null;
    if (!equal(parts[2], this.sign(parts[1]))) return null;
    try {
      const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as RegisteredClient;
      if (typeof parsed.expires !== "number" || parsed.expires <= Date.now()) return null;
      if (!Array.isArray(parsed.redirect_uris) || parsed.redirect_uris.length < 1 || parsed.redirect_uris.length > 4) return null;
      if (!parsed.redirect_uris.every(validateRedirect)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private resource(uri: string | null): string | null {
    const requested = uri || this.origin + "/mcp/music";
    return [this.origin + "/mcp", this.origin + "/mcp/music"].includes(requested) ? requested : null;
  }

  private clean() {
    const now = Date.now();
    for (const [key, usedAt] of this.usedConsentRequests) if (usedAt + AUTH_REQUEST_LIFETIME < now) this.usedConsentRequests.delete(key);
    for (const [key, value] of this.codes) if (value.created + AUTH_CODE_LIFETIME < now) this.codes.delete(key);
    for (const [key, value] of this.access) if (value.expires < now) this.access.delete(key);
    for (const [key, value] of this.refresh) if (value.expires < now) this.refresh.delete(key);
  }

  isAuthorized(header: string | undefined, mcpPath: string): boolean {
    if (!this.enabled || !header?.startsWith("Bearer ")) return false;
    const token = header.slice(7);
    const grant = this.access.get(createHash("sha256").update(token).digest("hex"));
    return !!grant && grant.expires > Date.now() && grant.resource === this.origin + mcpPath;
  }

  challenge(res: ServerResponse, path: string) {
    const metadata = this.origin + "/.well-known/oauth-protected-resource" + path;
    res.setHeader("WWW-Authenticate", 'Bearer resource_metadata="' + metadata + '"');
    bad(res, "unauthorized", 401);
  }

  private tokenResponse(res: ServerResponse, clientId: string, resource: string, scope = "cove:music") {
    const accessToken = opaqueToken();
    const refreshToken = opaqueToken();
    this.access.set(createHash("sha256").update(accessToken).digest("hex"),
      { clientId, resource, expires: Date.now() + ACCESS_LIFETIME });
    this.refresh.set(createHash("sha256").update(refreshToken).digest("hex"),
      { clientId, resource, expires: Date.now() + REFRESH_LIFETIME });
    json(res, 200, { access_token: accessToken, token_type: "Bearer",
      expires_in: ACCESS_LIFETIME / 1000, refresh_token: refreshToken, scope });
  }

  private loginForm(res: ServerResponse, id: string, message = "") {
    // Fixed HTML; never interpolate user-controlled OAuth values.
    const safeId = id.length <= 8192 && /^[A-Za-z0-9_.-]+$/.test(id) ? id : "";
    const msg = message ? "<p style=\"color:#9d3755\">Incorrect password or too many attempts. Please try later.</p>" : "";
    const html = '<!doctype html><html lang="en"><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Authorize Cove Resonance</title>' +
      '<style>body{margin:0;background:#eaf1f8;font:16px system-ui;display:grid;place-items:center;min-height:100vh}' +
      'main{background:white;padding:32px;border-radius:20px;width:min(360px,80vw);box-shadow:0 5px 40px #aac1d455}' +
      'input,button{display:block;box-sizing:border-box;width:100%;padding:13px;margin-top:16px;border-radius:10px;font:inherit}' +
      'button{background:#42698f;color:white;border:0}input{border:1px solid #abbcd1}</style>' +
      '<main><h2>Connect Cove Resonance</h2>' +
      '<p>Authorize ChatGPT to use your private NetEase music bridge. Only continue if you initiated this connection.</p>' +
      msg + '<form method="post" action="/oauth/approve">' +
      '<input type="hidden" name="request_id" value="' + safeId + '">' +
      '<label>Owner password<input name="password" type="password" autocomplete="current-password" required></label>' +
      '<button type="submit">Authorize music access</button></form></main></html>';
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    res.end(html);
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    const routes = ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource/mcp/music",
      "/oauth/register", "/oauth/authorize", "/oauth/approve", "/oauth/token"];
    if (!routes.includes(p)) return false;
    if (!this.enabled) {
      bad(res, "oauth_not_configured", 503);
      return true;
    }
    this.clean();
    if (p === "/.well-known/oauth-authorization-server" && req.method === "GET") {
      json(res, 200, {
        issuer: this.origin, authorization_endpoint: this.origin + "/oauth/authorize",
        token_endpoint: this.origin + "/oauth/token",
        registration_endpoint: this.origin + "/oauth/register",
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["cove:music"],
      });
      return true;
    }
    if (p.startsWith("/.well-known/oauth-protected-resource") && req.method === "GET") {
      const suffix = p.slice("/.well-known/oauth-protected-resource".length);
      const resource = this.resource(suffix ? this.origin + suffix : null);
      if (!resource) { bad(res, "invalid_resource", 404); return true; }
      json(res, 200, { resource, authorization_servers: [this.origin],
        bearer_methods_supported: ["header"], scopes_supported: ["cove:music"] });
      return true;
    }
    try {
      if (p === "/oauth/register" && req.method === "POST") {
        const obj = await registrationJson(req) as Record<string, unknown>;
        if (!obj || typeof obj !== "object" || !Array.isArray(obj.redirect_uris) ||
            obj.redirect_uris.length < 1 || obj.redirect_uris.length > 4 ||
            !obj.redirect_uris.every((v: unknown) => typeof v === "string" && validateRedirect(v))) {
          bad(res, "invalid_redirect_uri"); return true;
        }
        if (obj.token_endpoint_auth_method && obj.token_endpoint_auth_method !== "none") {
          bad(res, "invalid_client_metadata"); return true;
        }
        if (obj.grant_types && (!Array.isArray(obj.grant_types) ||
            obj.grant_types.some((v: unknown) => !["authorization_code", "refresh_token"].includes(String(v))))) {
          bad(res, "invalid_client_metadata"); return true;
        }
        const data: RegisteredClient = {
          redirect_uris: obj.redirect_uris as string[], expires: Date.now() + 365 * 24 * 60 * 60_000,
        };
        const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
        const clientId = "cove." + payload + "." + this.sign(payload);
        json(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000),
          client_secret_expires_at: 0, redirect_uris: data.redirect_uris,
          token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"] });
        return true;
      }
      if (p === "/oauth/authorize" && req.method === "GET") {
        const clientId = url.searchParams.get("client_id") ?? "";
        const client = this.clientFromId(clientId);
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const resource = this.resource(url.searchParams.get("resource"));
        if (!client || !client.redirect_uris.includes(redirectUri) ||
            url.searchParams.get("response_type") !== "code" ||
            url.searchParams.get("code_challenge_method") !== "S256" ||
            !PKCE_CHALLENGE.test(challenge) || !resource) {
          bad(res, "invalid_request"); return true;
        }
        const id = sealPendingRequest<PendingRequest>({ clientId, redirectUri, challenge,
          state: url.searchParams.get("state") ?? "", resource, created: Date.now() }, this.signingSecret);
        console.info("[OAuth] authorize_form_created", JSON.stringify({ idLength: id.length, mode: "sealed_v1" }));
        this.loginForm(res, id);
        return true;
      }
      if (p === "/oauth/approve" && req.method === "POST") {
        const form = await formData(req);
        const id = form.get("request_id") ?? "";
        const pending = unsealPendingRequest<PendingRequest>(
          id, this.signingSecret, AUTH_REQUEST_LIFETIME);
        const consentHash = createHash("sha256").update(id).digest("hex");
        if (!pending || this.usedConsentRequests.has(consentHash)) {
          const reason = !id ? "missing_request_id"
            : !id.startsWith("v1.") ? "legacy_or_malformed_form"
            : this.usedConsentRequests.has(consentHash) ? "already_consumed"
            : "sealed_form_invalid_or_expired";
          console.warn("[OAuth] approve_rejected", JSON.stringify({
            reason, idLength: id.length, requestAgeStatus: "not_logged",
          }));
          bad(res, "expired_request", 400);
          return true;
        }
        console.info("[OAuth] approve_form_valid", JSON.stringify({
          ageSeconds: Math.max(0, Math.floor((Date.now() - pending.created) / 1000)),
        }));
        if (Date.now() < this.lockedUntil) { this.loginForm(res, id, "locked"); return true; }
        if (!equal(form.get("password") ?? "", this.ownerPassword)) {
          console.warn("[OAuth] owner_password_rejected");
          this.failedLogins += 1;
          if (this.failedLogins >= 5) { this.lockedUntil = Date.now() + 15 * 60_000; this.failedLogins = 0; }
          this.loginForm(res, id, "bad password");
          return true;
        }
        this.failedLogins = 0;
        this.usedConsentRequests.set(consentHash, Date.now());
        console.info("[OAuth] owner_authorization_approved");
        const code = opaqueToken();
        this.codes.set(createHash("sha256").update(code).digest("hex"), pending);
        const redirect = new URL(pending.redirectUri);
        redirect.searchParams.set("code", code);
        if (pending.state) redirect.searchParams.set("state", pending.state);
        redirect.searchParams.set("iss", this.origin);
        res.writeHead(302, { location: redirect.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" });
        res.end();
        return true;
      }
      if (p === "/oauth/token" && req.method === "POST") {
        const form = await formData(req);
        const clientId = form.get("client_id") ?? "";
        if (!this.clientFromId(clientId)) { bad(res, "invalid_client", 401); return true; }
        if (form.get("grant_type") === "authorization_code") {
          const code = form.get("code") ?? "";
          const key = createHash("sha256").update(code).digest("hex");
          const saved = this.codes.get(key);
          if (!saved || saved.clientId !== clientId || saved.redirectUri !== form.get("redirect_uri") ||
              saved.created + AUTH_CODE_LIFETIME < Date.now()) {
            bad(res, "invalid_grant"); return true;
          }
          const verifier = form.get("code_verifier") ?? "";
          if (!PKCE_VERIFIER.test(verifier) || !equal(pkceS256(verifier), saved.challenge)) {
            bad(res, "invalid_grant"); return true;
          }
          if (form.has("resource") && form.get("resource") !== saved.resource) {
            bad(res, "invalid_target"); return true;
          }
          this.codes.delete(key);
          this.tokenResponse(res, clientId, saved.resource);
          return true;
        }
        if (form.get("grant_type") === "refresh_token") {
          const key = createHash("sha256").update(form.get("refresh_token") ?? "").digest("hex");
          const saved = this.refresh.get(key);
          if (!saved || saved.clientId !== clientId || saved.expires < Date.now() ||
              (form.has("resource") && form.get("resource") !== saved.resource)) {
            bad(res, "invalid_grant"); return true;
          }
          this.refresh.delete(key);
          this.tokenResponse(res, clientId, saved.resource);
          return true;
        }
        bad(res, "unsupported_grant_type"); return true;
      }
    } catch {
      bad(res, "invalid_request");
      return true;
    }
    bad(res, "method_not_allowed", 405);
    return true;
  }
}
