import assert from "node:assert/strict";
import test from "node:test";
import { ListenerWakeScheduler, LISTENER_WAKE_SOURCE } from "../src/listenerWakeScheduler.js";
import { InMemoryEventQueue } from "../src/queue.js";
import { buildBridgeEvent } from "../src/bridge/events.js";
import { acceptsProfileSource } from "../src/profiles.js";

const MINUTE = 60_000;
const NOON = Date.parse("2026-10-26T04:00:00Z");

function setup(enabled = true) {
  let at = NOON;
  let clients = 1;
  let hints = 0;
  const queue = new InMemoryEventQueue(() => at);
  const worker = new ListenerWakeScheduler(queue, {
    enabled, intervalMinutes: 15, firstDelaySeconds: 60,
  }, () => clients, () => { hints++; }, () => at);
  return { queue, worker, setTime(value: number) { at = value; },
    setClients(value: number) { clients = value; }, hints: () => hints };
}

test("fixed Listener wakes are delayed then separated by 15 minutes with no reply route", () => {
  const s = setup();
  assert.equal(s.worker.tick(NOON), false);
  s.setTime(NOON + MINUTE);
  assert.equal(s.worker.tick(), true);
  const event = s.queue.reserveNext();
  assert.ok(event);
  assert.equal(event.kind, "wake");
  assert.equal(event.source, LISTENER_WAKE_SOURCE);
  assert.equal(event.stream, "state");
  assert.equal(event.replyRoute, undefined);
  assert.equal(event.replyPolicy, undefined);
  assert.match(event.modelContext, /not a message written by the human/);
  assert.match(event.modelContext, /do not call cove_bridge_reply/);
  assert.match(event.modelContext, /remain silent/);
  s.queue.markDelivered(event.id);
  s.setTime(NOON + 15 * MINUTE);
  assert.equal(s.worker.tick(), false);
  s.setTime(NOON + 16 * MINUTE);
  assert.equal(s.worker.tick(), true);
  assert.equal(s.hints(), 2);
});

test("scheduler defaults off and skips quiet hours, offline, and competing Listeners", () => {
  const disabled = setup(false);
  assert.equal(disabled.worker.tick(NOON + MINUTE), false);
  assert.equal(disabled.worker.status().lastReason, "disabled");
  const s = setup();
  s.setTime(NOON + MINUTE);
  s.setClients(0);
  assert.equal(s.worker.tick(), false);
  assert.equal(s.worker.status().lastReason, "listener_offline");
  s.setClients(2);
  assert.equal(s.worker.tick(), false);
  assert.equal(s.worker.status().lastReason, "multiple_listeners");
  s.setClients(1);
  s.setTime(Date.parse("2026-10-26T17:00:00Z")); // 01:00 next local day
  assert.equal(s.worker.tick(), false);
  assert.equal(s.worker.status().lastReason, "quiet_hours");
  s.setTime(Date.parse("2026-10-27T00:59:59Z"));
  assert.equal(s.worker.tick(), false);
  s.setTime(Date.parse("2026-10-27T01:00:00Z")); // 09:00
  assert.equal(s.worker.tick(), true);
  assert.equal(s.queue.status().total, 1); // no backlog for missed periods
});

test("real inbound messages and outstanding replies take priority over scheduled wakes", () => {
  const s = setup();
  s.setTime(NOON + MINUTE);
  s.queue.enqueue(buildBridgeEvent("real-message", "pwa.chat", "Local test"));
  assert.equal(s.worker.tick(), false);
  assert.equal(s.worker.status().lastReason, "queue_busy");
  s.queue.reserveNext();
  s.queue.markDelivered("real-message");
  assert.equal(s.worker.tick(), false);
  assert.equal(s.queue.getOutstandingRequiredReplyEvent()?.id, "real-message");
  s.queue.dismiss("real-message");
  assert.equal(s.worker.tick(), true);
});

test("expired pending wakes are dropped before resume without discarding reserved events", () => {
  const s = setup();
  s.setTime(NOON + MINUTE);
  assert.equal(s.worker.tick(), true);
  s.setTime(NOON + 4 * MINUTE);
  assert.equal(s.queue.reserveNext(), null);
  assert.equal(s.queue.status().total, 0);
  s.setTime(NOON + 16 * MINUTE);
  assert.equal(s.worker.tick(), true);
  const reserved = s.queue.reserveNext()!;
  s.setTime(NOON + 20 * MINUTE);
  s.queue.pruneExpiredPendingStates();
  assert.equal(s.queue.getEvent(reserved.id)?.id, reserved.id);
  assert.equal(s.queue.status().reserved, 1);
});

test("same-slot restart uses a stable event id; interval validation cannot create rapid loops", () => {
  const s = setup();
  s.setTime(NOON + MINUTE);
  s.worker.tick();
  const originalId = s.worker.status().lastEventId;
  const otherQueue = new InMemoryEventQueue(() => NOON);
  const restarted = new ListenerWakeScheduler(otherQueue, {
    enabled: true, firstDelaySeconds: 60,
  }, () => 1, () => {}, () => NOON);
  restarted.tick(NOON + 2 * MINUTE);
  assert.equal(restarted.status().lastEventId, originalId);
  assert.throws(() => new ListenerWakeScheduler(otherQueue, {
    enabled: true, intervalMinutes: 1,
  }, () => 1, () => {}), /15–1440/);
});

test("public fixed wake source stays isolated from music and private sources", () => {
  const oldIsolated = process.env.BRIDGE_ISOLATED_MODE;
  const oldToken = process.env.BRIDGE_MCP_TOKEN;
  try {
    process.env.BRIDGE_ISOLATED_MODE = "true";
    delete process.env.BRIDGE_MCP_TOKEN;
    assert.equal(acceptsProfileSource("bridge", LISTENER_WAKE_SOURCE), true);
    assert.equal(acceptsProfileSource("music", LISTENER_WAKE_SOURCE), false);
    assert.equal(acceptsProfileSource("bridge", "wake.heartbeat"), false);
    assert.equal(acceptsProfileSource("bridge", "pwa.chat"), false);
  } finally {
    if (oldIsolated === undefined) delete process.env.BRIDGE_ISOLATED_MODE;
    else process.env.BRIDGE_ISOLATED_MODE = oldIsolated;
    if (oldToken === undefined) delete process.env.BRIDGE_MCP_TOKEN;
    else process.env.BRIDGE_MCP_TOKEN = oldToken;
  }
});
