import assert from "node:assert/strict";
import test from "node:test";

test("isolated unauthenticated generic service is fixed-test-only", async () => {
  const old = {
    NODE_ENV: process.env.NODE_ENV,
    BRIDGE_ISOLATED_MODE: process.env.BRIDGE_ISOLATED_MODE,
    BRIDGE_MCP_TOKEN: process.env.BRIDGE_MCP_TOKEN,
    BRIDGE_INGEST_TOKEN: process.env.BRIDGE_INGEST_TOKEN,
  };
  process.env.NODE_ENV = "test";
  process.env.BRIDGE_ISOLATED_MODE = "true";
  delete process.env.BRIDGE_MCP_TOKEN;
  process.env.BRIDGE_INGEST_TOKEN = "unit-test-token-not-a-secret";

  const { createHttpServer } = await import("../src/server.js");
  const server = createHttpServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const url = "http://127.0.0.1:" + addr.port;
    async function request(path: string, method = "GET", body?: object, token?: string) {
      const response = await fetch(url + path, {
        method,
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          ...(token ? { authorization: "Bearer " + token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, data: await response.json() as Record<string, unknown> };
    }
    const token = process.env.BRIDGE_INGEST_TOKEN;
    const payload = { eventId: "not-allowed", source: "pwa.chat", text: "private" };
    assert.equal((await request("/events", "POST", payload)).status, 401);
    assert.equal((await request("/events", "POST", payload, token)).status, 403);
    assert.equal((await request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).status, 404);
    assert.equal((await request("/mcp/music", "POST", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).status, 404);

    const posted = await request("/events", "POST", {
      eventId: "isolated-safe-test",
      source: "test.general-bridge",
      text: "Synthetic non-sensitive test only",
    }, token);
    assert.equal(posted.status, 201);

    const listed = await request("/mcp/bridge", "POST", { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    assert.equal(listed.status, 200);
    const names = new Set(((listed.data.result as { tools: Array<{ name: string }> }).tools).map(x => x.name));
    assert.equal(names.has("open_cove_bridge"), true);
    assert.equal(names.has("netease_together_now"), false);

    const sync = await request("/mcp/bridge", "POST", {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "cove_bridge_wait", arguments: { timeoutSeconds: 1 } },
    });
    const ev = (sync.data.result as { structuredContent: { eventId?: string, hasEvent: boolean } }).structuredContent;
    assert.equal(ev.hasEvent, true);
    assert.equal(ev.eventId, "isolated-safe-test");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(old) as Array<keyof typeof old>) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
});
