import assert from "node:assert/strict";
import test from "node:test";
import { buildBridgeEvent } from "../src/bridge/events.js";
import { ExternalReplyInbox } from "../src/externalReplyInbox.js";
import { WakeWorker } from "../src/wakeWorker.js";
import { InMemoryEventQueue } from "../src/queue.js";
import { acceptsProfileSource } from "../src/profiles.js";

test("generic external messages require an inbox reply, never NetEase", () => {
  const event = buildBridgeEvent("external-001", "pwa.chat", "hello");
  assert.equal(event.kind, "message");
  assert.equal(event.replyRoute, "external.inbox");
  assert.equal(event.replyPolicy, "required");
  assert.equal(event.stream, "conversation");
  assert.match(event.modelContext, /Do NOT send this reply to NetEase/);
});

test("wake event is ephemeral, distinct from user speech, with no reply route", () => {
  const event = buildBridgeEvent("wake-001", "wake.heartbeat", "check");
  assert.equal(event.kind, "wake");
  assert.equal(event.stream, "state");
  assert.equal(event.replyRoute, undefined);
  assert.equal(event.replyPolicy, undefined);
  assert.match(event.modelContext, /not a message typed by the human/);
});

test("generic /mcp/bridge sees no music and music profile sees no external messages", () => {
  assert.equal(acceptsProfileSource("bridge", "pwa.chat"), true);
  assert.equal(acceptsProfileSource("bridge", "wake.heartbeat"), true);
  assert.equal(acceptsProfileSource("bridge", "netease.chatroom"), false);
  assert.equal(acceptsProfileSource("music", "pwa.chat"), false);
  assert.equal(acceptsProfileSource("music", "netease.chatroom"), true);
});

test("external reply inbox copies replies and marks completion", () => {
  const inbox = new ExternalReplyInbox();
  assert.equal(inbox.read("evt"), null);
  inbox.append("evt", "one");
  inbox.append("evt", "two");
  inbox.complete("evt");
  const record = inbox.read("evt");
  assert.deepEqual(record?.messages, ["one", "two"]);
  assert.equal(record?.completed, true);
  record?.messages.push("unauthorized-mutating-copy");
  assert.deepEqual(inbox.read("evt")?.messages, ["one", "two"]);
});

test("wake worker respects silence, one-hour gap and quiet hours", () => {
  const queue = new InMemoryEventQueue();
  // 12:00 local Singapore time.
  const noon = Date.parse("2026-10-25T04:00:00Z");
  const worker = new WakeWorker(queue, () => noon);
  assert.equal(worker.evaluate(noon + 44 * 60_000).reason, "recent_user_activity");
  assert.equal(worker.tick(noon + 45 * 60_000), true);
  assert.equal(worker.evaluate(noon + 46 * 60_000).reason, "minimum_interval");
  assert.equal(worker.tick(noon + 105 * 60_000), true);
  assert.equal(queue.status().state.pending, 1); // stale pending wake coalesced
  const night = Date.parse("2026-10-25T18:10:00Z"); // 02:10 Singapore
  assert.equal(worker.evaluate(night).reason, "quiet_hours");
  worker.noteUserActivity(noon + 110 * 60_000);
  assert.equal(worker.evaluate(noon + 111 * 60_000).reason, "recent_user_activity");
});

import { buildListenerHtml } from "../src/listener-html.js";

test("generic Listener has self-test buttons and original music widget stays unchanged", () => {
  const generic = buildListenerHtml(true);
  const original = buildListenerHtml();
  assert.match(generic, /id="general-test-send"/);
  assert.match(generic, /id="general-test-check"/);
  assert.match(generic, /cove_bridge_test_event/);
  assert.match(generic, /cove_bridge_test_status/);
  assert.doesNotMatch(original, /id="general-test-send"/);
});
