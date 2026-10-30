import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { signature, subscriptionId, wakeSlot } from "../src/workEvents.js";

test("wake slots respect Shanghai 01:00–09:00 and deduplicate within a quarter hour", () => {
  assert.equal(wakeSlot(new Date("2026-10-27T16:59:59Z")), "2026-10-27T16:45:00.000Z");
  assert.equal(wakeSlot(new Date("2026-10-27T17:00:00Z")), null);
  assert.equal(wakeSlot(new Date("2026-10-28T00:59:59Z")), null);
  assert.equal(wakeSlot(new Date("2026-10-28T01:00:00Z")), "2026-10-28T01:00:00.000Z");
  assert.equal(wakeSlot(new Date("2026-10-28T01:14:59Z")), "2026-10-28T01:00:00.000Z");
});

test("subscription identity and Standard Webhooks signature are stable", () => {
  const first = subscriptionId("owner", "work.wake", {}, "https://chatgpt.com/callback/a");
  assert.equal(first, subscriptionId("owner", "work.wake", {}, "https://chatgpt.com/callback/a"));
  assert.notEqual(first, subscriptionId("owner", "work.wake", {}, "https://chatgpt.com/callback/b"));
  const secret = "whsec_" + Buffer.alloc(32, 42).toString("base64");
  const body = JSON.stringify({ eventId: "evt_1", name: "work.wake" });
  const expected = createHmac("sha256", Buffer.alloc(32, 42)).update(`evt_1.42.${body}`).digest("base64");
  assert.equal(signature(secret, "evt_1", 42, body), "v1," + expected);
});
