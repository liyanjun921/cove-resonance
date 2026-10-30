import assert from "node:assert/strict";
import test from "node:test";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const { createHttpServer } = await import("../src/server.js");
  if (previous === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previous;

  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run("http://127.0.0.1:" + address.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function rpc(base: string, path: string, id: number, method: string) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "compat-test", version: "1.0.0" },
          }
        : {},
    }),
  });
  assert.equal(response.status, 200, path + ":" + method);
  return await response.json() as {
    result?: {
      serverInfo?: { name?: string };
      tools?: Array<{ name: string }>;
      resources?: Array<{ uri: string }>;
    };
  };
}

test("legacy /mcp and scoped /mcp/music both initialize", async () => {
  await withServer(async (base) => {
    const legacy = await rpc(base, "/mcp", 1, "initialize");
    const music = await rpc(base, "/mcp/music", 2, "initialize");
    const general = await rpc(base, "/mcp/bridge", 5, "initialize");
    assert.equal(legacy.result?.serverInfo?.name, "cove-resonance");
    assert.equal(music.result?.serverInfo?.name, "cove-resonance-music");
    assert.equal(general.result?.serverInfo?.name, "cove-resonance-bridge");
  });
});

test("legacy and scoped endpoints both keep the Music V2 tool surface", async () => {
  const required = [
    "netease_together_now",
    "netease_together_realtime_status",
    "netease_together_leave",
    "netease_together_pause",
    "netease_together_resume",
    "netease_together_goto",
    "netease_together_next",
    "netease_together_enqueue_next",
    "netease_together_send_message",
    "open_cove_bridge",
    "cove_bridge_listener_session",
    "cove_bridge_reply",
    "cove_bridge_sync",
    "cove_bridge_delivered",
    "cove_bridge_dismissed",
    "cove_bridge_release",
    "cove_bridge_wait",
    "cove_bridge_wait_ack",
  ];
  await withServer(async (base) => {
    for (const path of ["/mcp", "/mcp/music"]) {
      const body = await rpc(base, path, 3, "tools/list");
      const names = new Set((body.result?.tools ?? []).map((tool) => tool.name));
      for (const name of required) assert.equal(names.has(name), true, path + ":" + name);
    }
  });
});

test("stable widget resource URI is preserved", async () => {
  await withServer(async (base) => {
    for (const path of ["/mcp", "/mcp/music"]) {
      const body = await rpc(base, path, 4, "resources/list");
      const uris = new Set((body.result?.resources ?? []).map((resource) => resource.uri));
      assert.equal(uris.has("ui://widget/cove-bridge.html"), true, path);
    }
  });
});

test("dedicated bridge endpoint exposes Listener and reply without music account tools", async () => {
  await withServer(async (base) => {
    const listed = await rpc(base, "/mcp/bridge", 20, "tools/list");
    const names = new Set((listed.result?.tools ?? []).map(tool => tool.name));
    assert.equal(names.has("open_cove_bridge"), true);
    assert.equal(names.has("cove_bridge_sync"), true);
    assert.equal(names.has("cove_bridge_reply"), true);
    assert.equal(names.has("netease_my_playlists"), false);
    assert.equal(names.has("netease_together_now"), false);
  });
});

test("generic movie render overrides cached descriptors and keeps the legacy URI readable", async () => {
  await withServer(async (base) => {
    async function call(method: string, params: object) {
      const r = await fetch(base + '/mcp/bridge', { method: 'POST',
        headers: {'content-type':'application/json',accept:'application/json, text/event-stream'},
        body: JSON.stringify({jsonrpc:'2.0',id:99,method,params}) });
      assert.equal(r.status,200);
      return (await r.json() as {result:any}).result;
    }
    const list = await call('tools/list',{});
    const descriptor = list.tools.find((t:any)=>t.name==='open_cove_bridge');
    const uri = descriptor._meta.ui.resourceUri;
    assert.equal(uri,'ui://widget/xlc-general-cinema-v2.html');
    const rendered = await call('tools/call',{name:'open_cove_bridge',arguments:{}});
    assert.equal(rendered.structuredContent.componentVersion,'cinema-2');
    assert.equal(rendered.structuredContent.listening,false);
    assert.equal(rendered._meta.ui.resourceUri,uri);
    assert.equal(rendered._meta['openai/outputTemplate'],uri);
    assert.equal(rendered._meta['ui/resourceUri'],uri);
    for(const requested of [uri,'ui://widget/xlc-general-bridge.html']) {
      const read = await call('resources/read',{uri:requested});
      const c = read.contents[0];
      assert.equal(c.uri,requested);
      assert.equal(c.mimeType,'text/html;profile=mcp-app');
      assert.match(c.text,/同帧电影共看 v2/);
      for(const id of ['cinema-start','cinema-test','cinema-stop']) assert.ok(c.text.includes('id="'+id+'"'));
      assert.equal(c._meta.ui.resourceUri,undefined);
    }
  });
});
