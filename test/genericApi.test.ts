import assert from "node:assert/strict";
import test from "node:test";

const TOKEN = "ci-placeholder-not-a-real-secret";

test("authenticated generic event completes MCP bridge reply into external inbox", async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  process.env.BRIDGE_INGEST_TOKEN = TOKEN;
  const { createHttpServer } = await import("../src/server.js");
  if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = oldNodeEnv;

  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    const eventId = "generic-integration-001";
    const eventBody = JSON.stringify({ eventId, source: "pwa.chat", text: "Hello, from a browser gateway" });

    const denied = await fetch(base + "/events", {
      method: "POST", headers: { "content-type": "application/json" }, body: eventBody,
    });
    assert.equal(denied.status, 401);

    const accepted = await fetch(base + "/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
      body: eventBody,
    });
    assert.equal(accepted.status, 201);

    const deniedRead = await fetch(base + "/external/replies?eventId=" + eventId);
    assert.equal(deniedRead.status, 401);

    const notReady = await fetch(base + "/external/replies?eventId=" + eventId, {
      headers: { authorization: "Bearer " + TOKEN },
    });
    assert.equal(notReady.status, 404);

    async function invoke(id: number, name: string, args: object) {
      const response = await fetch(base + "/mcp/bridge", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
        }),
      });
      assert.equal(response.status, 200, name);
      return await response.json() as { result?: { structuredContent?: Record<string, unknown> }; error?: unknown };
    }
    const wait = await invoke(1, "cove_bridge_wait", { timeoutSeconds: 2 });
    assert.equal(wait.result?.structuredContent?.eventId, eventId);
    const ack = await invoke(2, "cove_bridge_wait_ack", { eventId });
    assert.equal(ack.result?.structuredContent?.acknowledged, true);
    const reply = await invoke(3, "cove_bridge_reply", { messages: ["Hello, this is XLC.", "No music was involved."] });
    assert.equal(reply.result?.structuredContent?.completed, true);
    assert.equal(reply.result?.structuredContent?.route, "external.inbox");

    const delivered = await fetch(base + "/external/replies?eventId=" + eventId, {
      headers: { authorization: "Bearer " + TOKEN },
    });
    assert.equal(delivered.status, 200);
    const data = await delivered.json() as { completed: boolean; messages: string[] };
    assert.equal(data.completed, true);
    assert.deepEqual(data.messages, ["Hello, this is XLC.", "No music was involved."]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
