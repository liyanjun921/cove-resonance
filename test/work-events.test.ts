import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign as signDetached } from "node:crypto";
import test from "node:test";
import { signature, subscriptionId, verifyGardenEventSignature, wakeSlot } from "../src/workEvents.js";

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

test("Garden ingress accepts only fresh, untampered Ed25519 events", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  assert.equal(typeof jwk.x, "string");
  const eventId = "garden_6691_42";
  const timestamp = 1_800_000_000;
  const text = "花园里有人叫你。";
  const signed = Buffer.from(JSON.stringify([eventId, timestamp, text]));
  const detached = signDetached(null, signed, privateKey).toString("base64url");
  const now = timestamp * 1000;

  assert.equal(verifyGardenEventSignature(jwk.x!, eventId, timestamp, text, detached, now), true);
  assert.equal(verifyGardenEventSignature(jwk.x!, eventId, timestamp, text + "篡改", detached, now), false);
  assert.equal(verifyGardenEventSignature(jwk.x!, eventId, timestamp - 301, text, detached, now), false);
});
