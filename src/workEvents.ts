/** Work MCP Events adapter. Kept separate from the legacy Listener and music queue. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

type Subscription = {
  id: string; name: string; arguments: Record<string, unknown>; url: string;
  secret: string; expires_at: string;
};
type Delivery = {
  id: string; subscription_id: string; body: Record<string, unknown>;
  attempts: number; subscription: Subscription;
};
type EventName = "general.message" | "work.wake";

const protocolVersion = "2026-07-28";
const eventDefinitions = [
  {
    name: "general.message", description: "An authenticated external source sent a message to this Work chat.",
    delivery: ["webhook"], inputSchema: { type: "object", properties: {}, additionalProperties: false },
    payloadSchema: { type: "object", properties: {
      event_id: { type: "string" }, source: { type: "string" }, text: { type: "string" },
    }, required: ["event_id", "source", "text"], additionalProperties: false },
  },
  {
    name: "work.wake", description: "A 15-minute timer elapsed outside the configured quiet hours. Decide whether to speak in this chat.",
    delivery: ["webhook"], inputSchema: { type: "object", properties: {}, additionalProperties: false },
    payloadSchema: { type: "object", properties: {
      slot: { type: "string" }, signal: { type: "string" },
    }, required: ["slot", "signal"], additionalProperties: false },
  },
] as const;

function equalSecret(expected: string, actual: string | undefined): boolean {
  if (!expected || !actual) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(actual).digest();
  return timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    if (bytes > 64 * 1024) throw new Error("request_too_large");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bearer(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

const projectUrl = "https://kmligdmvjenjjlvrpqha.supabase.co";
const publishableKey = "sb_publishable_8UA5IAna561eaG3zy1PYkA_oA91TTbp";
const resource = "https://xlc-general-bridge-lyj.onrender.com/mcp/work";
const metadataUrl = "https://xlc-general-bridge-lyj.onrender.com/.well-known/oauth-protected-resource/mcp/work";

async function authorizedOwner(req: IncomingMessage, requireOAuth = false): Promise<boolean> {
  const token = bearer(req);
  if (!token) return false;
  if (equalSecret(process.env.WORK_EVENTS_MCP_TOKEN ?? "", token)) return true;
  if (!process.env.WORK_EVENTS_OWNER_USER_ID && !process.env.WORK_EVENTS_OWNER_EMAIL_SHA256) return false;
  try {
    const response = await fetch(`${projectUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const user = await response.json() as { id?: string; email?: string; email_confirmed_at?: string };
    const byId = Boolean(process.env.WORK_EVENTS_OWNER_USER_ID && user.id === process.env.WORK_EVENTS_OWNER_USER_ID);
    const emailHash = user.email && createHash("sha256").update(user.email.trim().toLowerCase()).digest("hex");
    const byEmail = Boolean(user.email_confirmed_at && process.env.WORK_EVENTS_OWNER_EMAIL_SHA256 &&
      emailHash && equalSecret(process.env.WORK_EVENTS_OWNER_EMAIL_SHA256, emailHash));
    if (!byId && !byEmail) return false;
    if (!requireOAuth) return true;
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      iss?: string; sub?: string; client_id?: string;
    };
    return claims.iss === `${projectUrl}/auth/v1` && claims.sub === user.id &&
      Boolean(process.env.WORK_EVENTS_OAUTH_CLIENT_ID) && claims.client_id === process.env.WORK_EVENTS_OAUTH_CLIENT_ID;
  } catch { return false; }
}

function unauthorized(res: ServerResponse): void {
  res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`);
  json(res, 401, { error: "unauthorized" });
}

export async function handleWorkOAuth(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path === "/.well-known/oauth-protected-resource/mcp/work" && req.method === "GET") {
    json(res, 200, { resource, authorization_servers: [`${projectUrl}/auth/v1`], bearer_methods_supported: ["header"] });
    return;
  }
  if (path === "/oauth/owner" && req.method === "GET") {
    if (!await authorizedOwner(req)) { unauthorized(res); return; }
    json(res, 200, { allowed: true }); return;
  }
  if (path === "/oauth/consent" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${projectUrl}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
    res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接谢临川 Work 事件桥</title><link rel="stylesheet" href="/oauth/consent.css"><main><h1>连接 Work 事件桥</h1><p id="message" role="status">正在检查授权请求…</p><section id="view" hidden><label>邮箱 <input id="email" type="email" autocomplete="email"></label><button id="sign-in">发送登录链接</button></section><section id="details" hidden><p>账号：<strong id="account"></strong></p><p>应用：<strong id="client"></strong></p><p>回调地址：<strong id="destination"></strong></p><p>权限：<strong id="scopes"></strong></p><button id="approve">允许连接</button><button id="deny">拒绝</button></section></main><script src="/oauth/consent.js?v=2" defer></script></html>`);
    return;
  }
  if (path === "/oauth/consent.css" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" });
    res.end(`:root{font:16px system-ui;color:#e8e7f2;background:#16151e}main{max-width:560px;margin:10vh auto;padding:32px;background:#24232f;border-radius:18px}h1{font-size:1.65rem}label{display:block;margin:18px 0}input{display:block;box-sizing:border-box;width:100%;margin-top:8px;padding:12px;border:1px solid #77718a;border-radius:8px;background:#16151e;color:inherit}button{padding:12px 18px;margin:8px 10px 8px 0;border:0;border-radius:8px;background:#a88ce6;color:#17121f;font-weight:600;cursor:pointer}button:disabled{opacity:.5}strong{overflow-wrap:anywhere}#message{line-height:1.6}`);
    return;
  }
  if (path === "/oauth/consent.js" && req.method === "GET") {
    try {
      const script = await readFile(new URL("../work-events/consent.js", import.meta.url));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(script);
    } catch { json(res, 503, { error: "consent_ui_unavailable" }); }
  }
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

export function subscriptionId(principal: string, name: string, args: object, url: string): string {
  return "sub_" + createHash("sha256").update(JSON.stringify([principal, name, args, url])).digest("hex").slice(0, 40);
}

export function wakeSlot(now: Date): string | null {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" }).format(now));
  if (hour >= 1 && hour < 9) return null;
  return new Date(Math.floor(now.getTime() / 900_000) * 900_000).toISOString();
}

export function signature(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.slice(6), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

function publicIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return !(lower === "::" || lower === "::1" || lower.startsWith("fc") ||
      lower.startsWith("fd") || /^fe[89ab]/.test(lower) || lower.startsWith("::ffff:"));
  }
  return false;
}

/** No redirects. Resolve and pin a public address for each connection. */
async function callbackPost(url: string, secret: string, id: string, subId: string, body: string): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const allowed = (process.env.WORK_EVENTS_CALLBACK_HOSTS ?? "chatgpt.com,openai.com")
    .split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password ||
      !allowed.some((domain) => host === domain || host.endsWith("." + domain)) || isIP(host)) {
    throw new Error("invalid_callback_url");
  }
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicIp(address))) throw new Error("unsafe_callback_address");
  const pinned = addresses[0];
  const timestamp = Math.floor(Date.now() / 1000);
  return await new Promise((resolve, reject) => {
    const req = httpsRequest(parsed, {
      method: "POST", timeout: 10_000,
      lookup: (_hostname, opts, cb) => {
        if (opts.all) cb(null, [pinned]);
        else cb(null, pinned.address, pinned.family);
      },
      headers: {
        "content-type": "application/json", "content-length": Buffer.byteLength(body),
        "webhook-id": id, "webhook-timestamp": String(timestamp),
        "webhook-signature": signature(secret, id, timestamp, body),
        "X-MCP-Subscription-Id": subId,
      },
    }, (response) => {
      let output = "";
      response.on("data", (chunk: Buffer) => { if (output.length < 4096) output += chunk.toString(); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: output }));
    });
    req.on("timeout", () => req.destroy(new Error("callback_timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

/** PostgREST tables are RLS-denied to public clients; only the server role accesses them. */
class Store {
  private readonly base = process.env.WORK_EVENTS_STORE_URL?.replace(/\/$/, "");
  private readonly key = process.env.WORK_EVENTS_STORE_TOKEN;

  get configured(): boolean { return Boolean(this.base && this.key); }

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.configured) throw new Error("work_event_store_unconfigured");
    const inputHeaders = new Headers(init.headers);
    const response = await fetch(this.base!, {
      method: "POST", headers: { Authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({ path, method: init.method ?? "GET", prefer: inputHeaders.get("prefer"),
        body: init.body ? JSON.parse(String(init.body)) : undefined }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`work_event_store_${response.status}`);
    const body = await response.text();
    return body ? JSON.parse(body) : null;
  }

  async upsert(sub: Subscription): Promise<void> {
    await this.call("work_event_subscriptions?on_conflict=id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(sub),
    });
  }
  async remove(id: string): Promise<void> {
    await this.call(`work_event_subscriptions?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  async active(name: EventName): Promise<Subscription[]> {
    return await this.call(`work_event_subscriptions?name=eq.${name}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=*`) as Subscription[];
  }
  async enqueue(sub: Subscription, eventId: string, data: Record<string, unknown>): Promise<void> {
    const body = { eventId, name: sub.name, timestamp: new Date().toISOString(), data, cursor: null };
    await this.call("work_event_deliveries?on_conflict=id", {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({ id: "del_" + createHash("sha256").update(sub.id + ":" + eventId).digest("hex"), subscription_id: sub.id, body }),
    });
  }
  async due(): Promise<Delivery[]> {
    return await this.call("rpc/claim_work_event_deliveries", {
      method: "POST", body: JSON.stringify({ batch_size: 30 }),
    }) as Delivery[];
  }
  async finish(id: string, attempts: number, status: number): Promise<void> {
    const done = status >= 200 && status < 300;
    const terminal = done || status === 410 || status === 413 || attempts >= 6;
    await this.call(`work_event_deliveries?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify({
        state: terminal ? (done ? "delivered" : "failed") : "pending",
        attempts, next_attempt_at: new Date(Date.now() + Math.min(3600, 2 ** attempts * 30) * 1000).toISOString(),
      }),
    });
  }
}

const store = new Store();

async function enqueue(name: EventName, eventId: string, data: Record<string, unknown>): Promise<number> {
  const subs = await store.active(name);
  await Promise.all(subs.map((sub) => store.enqueue(sub, eventId, data)));
  return subs.length;
}

async function dispatch(): Promise<{ delivered: number; retried: number }> {
  let delivered = 0;
  let retried = 0;
  for (const row of await store.due()) {
    if (!row.subscription || Date.parse(row.subscription.expires_at) <= Date.now()) {
      await store.finish(row.id, 6, 410); continue;
    }
    let status = 0;
    try {
      const result = await callbackPost(row.subscription.url, row.subscription.secret,
        String(row.body.eventId), row.subscription.id, JSON.stringify(row.body));
      status = result.status;
    } catch { /* bounded retry; do not log callback content or secrets */ }
    await store.finish(row.id, row.attempts + 1, status);
    if (status >= 200 && status < 300) delivered++; else retried++;
  }
  return { delivered, retried };
}

export async function handleWorkEvents(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const linked = path.startsWith("/mcp/work-link/");
  const linkToken = linked ? path.slice("/mcp/work-link/".length) : "";
  const mcp = path === "/mcp/work" || linked;
  const expected = mcp ? process.env.WORK_EVENTS_MCP_TOKEN :
    path === "/work/tick" ? process.env.WORK_EVENTS_TICK_TOKEN : process.env.WORK_EVENTS_INGEST_TOKEN;
  const allowed = linked
    ? /^[A-Za-z0-9_-]{43,}$/.test(linkToken) && equalSecret(process.env.WORK_EVENTS_LINK_TOKEN ?? "", linkToken)
    : mcp ? await authorizedOwner(req, true) : equalSecret(expected ?? "", bearer(req));
  if (!allowed) {
    if (linked) json(res, 404, { error: "not_found" });
    else if (mcp) unauthorized(res);
    else json(res, 401, { error: "unauthorized" });
    return;
  }
  if (!store.configured) { json(res, 503, { error: "work_event_store_unconfigured" }); return; }
  if (req.method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return; }
  try {
    const input = await readBody(req);
    if (!mcp) {
      if (path === "/work/events") {
        if (!object(input) || typeof input.eventId !== "string" || !input.eventId || input.eventId.length > 200 ||
          typeof input.source !== "string" || !input.source || input.source.length > 80 ||
          input.source.startsWith("netease.") || input.source.startsWith("wake.") ||
          typeof input.text !== "string" || !input.text || input.text.length > 4000) {
          json(res, 400, { error: "invalid_event" }); return;
        }
        const count = await enqueue("general.message", input.eventId, {
          event_id: input.eventId, source: input.source, text: input.text,
        });
        const delivery = await dispatch();
        json(res, 202, { accepted: true, eventId: input.eventId, subscriptions: count, ...delivery });
        return;
      }
      if (path === "/work/tick") {
        const slot = wakeSlot(new Date());
        if (slot) await enqueue("work.wake", "wake_" + slot, { slot, signal: "Scheduled check-in" });
        json(res, 200, { slot, ...await dispatch() }); return;
      }
    }
    if (!object(input) || input.jsonrpc !== "2.0" || typeof input.method !== "string") {
      json(res, 400, rpcError(null, -32600, "Invalid Request")); return;
    }
    const id = input.id;
    const reply = (result: unknown) => json(res, 200, { jsonrpc: "2.0", id, result });
    if (input.method === "server/discover") {
      reply({ resultType: "complete", supportedVersions: [protocolVersion], capabilities: { tools: {}, events: {} } }); return;
    }
    if (input.method === "initialize") {
      reply({ protocolVersion, capabilities: { tools: {}, events: {} }, serverInfo: { name: "xlc-work-events", version: "0.1.0" } }); return;
    }
    if (input.method === "notifications/initialized") { res.writeHead(202).end(); return; }
    if (input.method === "tools/list") { reply({ tools: [] }); return; }
    if (input.method === "events/list") { reply({ events: eventDefinitions }); return; }
    const params = input.params;
    if ((input.method === "events/subscribe" || input.method === "events/unsubscribe") && object(params)) {
      const name = params.name;
      const args = params.arguments;
      const delivery = params.delivery;
      if ((name !== "general.message" && name !== "work.wake") || !object(args) || Object.keys(args).length ||
          !object(delivery) || delivery.mode !== "webhook" || typeof delivery.url !== "string") {
        json(res, 200, rpcError(id, -32602, "Invalid event subscription")); return;
      }
      const subId = subscriptionId("single-owner", name, args, delivery.url);
      if (input.method === "events/unsubscribe") { await store.remove(subId); reply({}); return; }
      const secret = delivery.secret;
      const key = typeof secret === "string" && secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : null;
      if (typeof secret !== "string" || !key || key.length < 24 || key.length > 64) {
        json(res, 200, rpcError(id, -32602, "Invalid webhook signing secret")); return;
      }
      const challenge = randomBytes(24).toString("base64url");
      let verified = false;
      let verificationStatus = 0;
      try {
        const result = await callbackPost(delivery.url, secret, "msg_verification_" + randomBytes(12).toString("hex"),
          subId, JSON.stringify({ type: "verification", challenge }));
        verificationStatus = result.status;
        const echo = JSON.parse(result.body) as unknown;
        verified = result.status >= 200 && result.status < 300 && object(echo) &&
          typeof echo.challenge === "string" && equalSecret(challenge, echo.challenge);
      } catch (error) {
        console.warn("Work event callback verification error", error instanceof Error ? error.message : "unknown");
      }
      if (!verified) console.warn("Work event callback verification failed", verificationStatus);
      if (!verified) { json(res, 200, rpcError(id, -32015, "CallbackEndpointError", { reason: "challenge_failed" })); return; }
      const expires_at = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
      await store.upsert({ id: subId, name, arguments: args, url: delivery.url, secret, expires_at });
      reply({ id: subId, refreshBefore: expires_at, cursor: null, truncated: false }); return;
    }
    json(res, 200, rpcError(id, -32601, "Method not found"));
  } catch (error) {
    console.error("Work event request failed", error instanceof Error ? error.message : "unknown");
    json(res, error instanceof SyntaxError ? 400 : error instanceof Error && error.message === "request_too_large" ? 413 : 500,
      { error: "work_event_request_failed" });
  }
}
