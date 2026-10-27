import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";

test("Work MCP discovery is authenticated and isolated from external ingress", async () => {
  process.env.NODE_ENV = "test";
  process.env.BRIDGE_ISOLATED_MODE = "true";
  process.env.WORK_EVENTS_ENABLED = "true";
  process.env.WORK_EVENTS_STORE_URL = "https://example.supabase.co/functions/v1/work-store-proxy";
  process.env.WORK_EVENTS_STORE_TOKEN = "local-only-test-key";
  process.env.WORK_EVENTS_MCP_TOKEN = "mcp-local-only-test";
  process.env.WORK_EVENTS_INGEST_TOKEN = "ingress-local-only-test";
  const { createHttpServer } = await import("../src/server.js");
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const discover = (token: string) => fetch(base + "/mcp/work", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
    });
    assert.equal((await discover("wrong")).status, 401);
    const result = await (await discover("mcp-local-only-test")).json();
    assert.deepEqual(result.result.supportedVersions, ["2026-07-28"]);
    assert.ok(result.result.capabilities.events);

    const ingress = await fetch(base + "/work/events", {
      method: "POST", headers: { Authorization: "Bearer mcp-local-only-test", "content-type": "application/json" },
      body: JSON.stringify({ eventId: "e", source: "pwa.chat", text: "hello" }),
    });
    assert.equal(ingress.status, 401);
    const music = await fetch(base + "/mcp/music", { method: "POST" });
    assert.equal(music.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
