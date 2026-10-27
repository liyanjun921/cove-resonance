import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createMcpServer } from "./mcp.js";
import { buildBridgeEvent } from "./bridge/events.js";
export { buildBridgeEvent } from "./bridge/events.js";
import { MCP_PATHS } from "./profiles.js";
import { listenerWakeHub } from "./listenerWake.js";
import { externalReplyInbox } from "./externalReplyInbox.js";
import { WakeWorker } from "./wakeWorker.js";
import { ListenerWakeScheduler } from "./listenerWakeScheduler.js";
import { PlaybackStateStore } from "./netease/playbackState.js";
import { createTogetherWorker } from "./netease/togetherWorker.js";
import { InMemoryEventQueue } from "./queue.js";
import { handleWorkEvents, handleWorkOAuth } from "./workEvents.js";

const PORT = Number(process.env.PORT ?? 8787);
const INGEST_TOKEN = process.env.BRIDGE_INGEST_TOKEN ?? "";
const ISOLATED_MODE = process.env.BRIDGE_ISOLATED_MODE === "true";
const MCP_TOKEN = process.env.BRIDGE_MCP_TOKEN?.trim() ?? "";
const UNIX_SOCKET = process.env.BRIDGE_UNIX_SOCKET?.trim() ?? "";
const queue = new InMemoryEventQueue();
const wakeWorker = new WakeWorker(queue);
const listenerWakeScheduler = new ListenerWakeScheduler(queue, {
  enabled: ISOLATED_MODE && process.env.BRIDGE_LISTENER_WAKE_ENABLED === "true",
  intervalMinutes: ISOLATED_MODE ? Number(process.env.BRIDGE_LISTENER_WAKE_INTERVAL_MINUTES ?? 15) : 15,
  firstDelaySeconds: ISOLATED_MODE ? Number(process.env.BRIDGE_LISTENER_WAKE_FIRST_DELAY_SECONDS
    ?? Number(process.env.BRIDGE_LISTENER_WAKE_INTERVAL_MINUTES ?? 15) * 60) : 900,
}, () => listenerWakeHub.status().clients, () => listenerWakeHub.wake("scheduled-listener-wake"));
const playbackState = new PlaybackStateStore();

function enqueueTogetherEvent(
  source: string,
  text: string,
  additionalModelContext?: string,
): boolean {
  const id = randomUUID();
  const created = queue.enqueue(buildBridgeEvent(
    id,
    source,
    text,
    new Date().toISOString(),
    additionalModelContext,
  ));
  if (created) listenerWakeHub.wake(source);
  return created;
}

const togetherWorker = createTogetherWorker(enqueueTogetherEvent, playbackState);

const eventInput = z.object({
  eventId: z.string().trim().min(1).max(200).optional(),
  source: z.string().trim().min(1).max(80).default("test"),
  text: z.string().trim().min(1).max(4000),
});

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function authorized(req: IncomingMessage): boolean {
  return Boolean(INGEST_TOKEN) && req.headers.authorization === `Bearer ${INGEST_TOKEN}`;
}

export function createHttpServer() {
  return createServer(async (req, res) => {
    if (!req.url || !req.method) {
      res.writeHead(400).end("Bad Request");
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, authorization, mcp-session-id",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      writeJson(res, 200, {
        ok: true,
        service: "cove-bridge",
        version: "0.1.0",
        queue: queue.status(),
        listener: listenerWakeHub.status(),
        ...(ISOLATED_MODE ? { listenerWake: listenerWakeScheduler.status() } : {}),
      });
      return;
    }

    // Work Events are a separate, explicitly enabled Host adapter. The music
    // MCP endpoint and the legacy in-memory Listener never consume these rows.
    if (ISOLATED_MODE && process.env.WORK_EVENTS_ENABLED === "true" &&
        ["/oauth/consent", "/oauth/consent.js", "/oauth/consent.css", "/oauth/owner",
          "/.well-known/oauth-protected-resource/mcp/work"].includes(url.pathname)) {
      await handleWorkOAuth(req, res, url.pathname);
      return;
    }
    if (ISOLATED_MODE && process.env.WORK_EVENTS_ENABLED === "true" &&
        (["/mcp/work", "/work/events", "/work/tick"].includes(url.pathname) ||
          url.pathname.startsWith("/mcp/work-link/"))) {
      await handleWorkEvents(req, res, url.pathname);
      return;
    }

    if (req.method === "GET" && url.pathname === "/listener/events") {
      const authorization = req.headers.authorization ?? "";
      const bearerToken = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : "";
      const token = bearerToken || url.searchParams.get("session")?.trim() || "";
      const session = token ? listenerWakeHub.consumeSession(token) : null;
      if (!session) {
        writeJson(res, 401, { error: "invalid_or_expired_listener_session" });
        return;
      }
      listenerWakeHub.subscribe(res, session.expiresAtMs);
      return;
    }

    if (req.method === "POST" && url.pathname === "/events") {
      if (!authorized(req)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const parsed = eventInput.safeParse(await readJson(req));
        if (!parsed.success) {
          writeJson(res, 400, { error: parsed.error.flatten() });
          return;
        }
        if (ISOLATED_MODE && !MCP_TOKEN && parsed.data.source !== "test.general-bridge") {
          writeJson(res, 403, { error: "test_only_mode" });
          return;
        }
        const createdAt = new Date().toISOString();
        const id = parsed.data.eventId ?? randomUUID();
        const event = buildBridgeEvent(id, parsed.data.source, parsed.data.text, createdAt);
        const created = queue.enqueue(event);
        if (created) {
          if (!parsed.data.source.startsWith("wake.")) wakeWorker.noteUserActivity();
          listenerWakeHub.wake(parsed.data.source);
        }
        writeJson(res, created ? 201 : 200, { ok: true, created, eventId: id });
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid_request";
        writeJson(res, message === "request_too_large" ? 413 : 400, { error: message });
      }
      return;
    }

    // Server-to-server only: NEVER put BRIDGE_INGEST_TOKEN in a browser.
    if (req.method === "GET" && url.pathname === "/external/replies") {
      if (!authorized(req)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      const eventId = url.searchParams.get("eventId")?.trim() ?? "";
      if (!eventId || eventId.length > 200) {
        writeJson(res, 400, { error: "invalid_event_id" });
        return;
      }
      const reply = externalReplyInbox.read(eventId);
      writeJson(res, reply ? 200 : 404, reply ?? { error: "reply_not_found" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/external/activity") {
      if (!authorized(req)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      wakeWorker.noteUserActivity();
      writeJson(res, 200, { ok: true });
      return;
    }

    const mcpMethods = new Set(["POST", "GET", "DELETE"]);
    const mcpProfile = MCP_PATHS.get(url.pathname);
    if (mcpProfile && mcpMethods.has(req.method)) {
      if (ISOLATED_MODE && mcpProfile !== "bridge") {
        writeJson(res, 404, { error: "profile_not_available" });
        return;
      }
      if (ISOLATED_MODE && MCP_TOKEN && req.headers.authorization !== `Bearer ${MCP_TOKEN}`) {
        writeJson(res, 401, { error: "unauthorized_mcp" });
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      const server = createMcpServer(queue, playbackState, togetherWorker, mcpProfile);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("MCP request failed", error);
        if (!res.headersSent) writeJson(res, 500, { error: "internal_server_error" });
      }
      return;
    }

    res.writeHead(404).end("Not Found");
  });
}

if (process.env.NODE_ENV !== "test") {
  createHttpServer().listen(PORT, "0.0.0.0", () => {
    console.log("Cove Resonance listening on http://0.0.0.0:" + PORT + " (MCP: /mcp, /mcp/music, /mcp/bridge)");
    if (!ISOLATED_MODE) togetherWorker.start();
    if (process.env.BRIDGE_WAKE_ENABLED === "true") wakeWorker.start();
    listenerWakeScheduler.start();
  });

  if (UNIX_SOCKET) {
    if (existsSync(UNIX_SOCKET)) unlinkSync(UNIX_SOCKET);
    createHttpServer().listen(UNIX_SOCKET, () => {
      chmodSync(UNIX_SOCKET, 0o666);
      console.log("Cove Resonance listening on unix://" + UNIX_SOCKET + " (MCP: /mcp, /mcp/music)");
    });
  }
}
