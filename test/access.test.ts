import assert from "node:assert/strict";
import test from "node:test";
import { checkBearerAccess } from "../src/access.js";

test("production fails closed without configured token", () => {
  assert.equal(checkBearerAccess(undefined, "", true), "not_configured");
});
test("non-production permits empty token for loopback development", () => {
  assert.equal(checkBearerAccess(undefined, "", false), "allowed");
});
test("token rejects missing and malformed credentials", () => {
  assert.equal(checkBearerAccess(undefined, "secret", true), "unauthorized");
  assert.equal(checkBearerAccess("Basic abc", "secret", true), "unauthorized");
  assert.equal(checkBearerAccess("Bearer wrong", "secret", true), "unauthorized");
});
test("token accepts exact bearer only", () => {
  assert.equal(checkBearerAccess("Bearer secret", "secret", true), "allowed");
  assert.equal(checkBearerAccess("Bearer secret2", "secret", true), "unauthorized");
});
