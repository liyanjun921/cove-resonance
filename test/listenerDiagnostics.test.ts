import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { buildListenerHtml } from "../src/listener-html.js";

test("generic Listener keeps the host rejection visible after polling and never redispatches it", async () => {
  const elements = new Map<string, { textContent: string; disabled: boolean; click?: () => void }>();
  for (const id of ["status", "toggle", "host-error", "general-test-send", "general-test-check", "general-test-result", "cinema-start", "cinema-test", "cinema-stop", "cinema-status"]) {
    const element = { textContent: "", disabled: false, click: undefined as (() => void) | undefined };
    elements.set(id, element);
  }
  const calls: string[] = [];
  const immediate: Array<() => void> = [];
  let receive: (event: object) => void = () => {};
  let eventAvailable = true;
  const parent = {
    postMessage(message: { id?: number; method: string; params: { name?: string } }) {
      if (message.id === undefined) return;
      const name = message.method === "tools/call" ? message.params.name! : message.method;
      calls.push(name);
      let result: object = {};
      if (name === "cove_bridge_sync") {
        result = eventAvailable
          ? { _meta: { event: { id: "test:host-rejection", modelContext: "Fixed test", visibleText: "Fixed test" } } }
          : { structuredContent: { hasEvent: false } };
        eventAvailable = false;
      }
      queueMicrotask(() => receive({ source: parent, data: {
        jsonrpc: "2.0", id: message.id,
        ...(name === "ui/message"
          ? { error: { code: -32601, message: "Method not supported by this host" } }
          : { result }),
      } }));
    },
  };
  const window = {
    parent,
    addEventListener(name: string, handler: typeof receive) { if (name === "message") receive = handler; },
    setTimeout(callback: () => void, ms: number) { if (ms === 0) immediate.push(callback); return 1; },
    setInterval() { return 1; },
    clearInterval() {},
  };
  const script = buildListenerHtml(true).match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    window, URL,
    document: { getElementById(id: string) {
      const el = elements.get(id)!;
      return Object.assign(el, { addEventListener(_name: string, callback: () => void) { el.click = callback; } });
    } },
    localStorage: { getItem() { return null; }, setItem() {} },
  });
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  await settle();
  assert.equal(elements.get("toggle")?.disabled, false);
  elements.get("toggle")?.click?.();
  await settle();
  assert.equal(calls.filter(name => name === "ui/message").length, 1);
  assert.ok(calls.includes("cove_bridge_dismissed"));
  assert.ok(!calls.includes("cove_bridge_release"));
  assert.ok(!calls.includes("cove_bridge_delivered"));
  const diagnostic = elements.get("host-error")!.textContent;
  assert.match(diagnostic, /-32601/);
  assert.match(diagnostic, /Method not supported by this host/);
  assert.match(diagnostic, /不代表已经回复/);
  while (immediate.length) immediate.shift()!();
  await settle();
  assert.equal(elements.get("host-error")?.textContent, diagnostic);
  assert.equal(calls.filter(name => name === "ui/message").length, 1);
});
