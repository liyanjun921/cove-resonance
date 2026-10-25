import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PersonalOAuthServer, pkceS256 } from "../src/oauth.js";
import { sealPendingRequest, unsealPendingRequest } from "../src/oauthPending.js";

const origin = "https://cove.example.test";
const password = "a-very-long-owner-password";
const secret = "S".repeat(64);

test("sealed OAuth request survives process re-creation, detects tampering and expires", () => {
  const now = Date.now();
  const state = { created: now, state: "hidden-user-state", clientId: "abc" };
  const sealed = sealPendingRequest(state, secret);
  assert.equal(sealed.includes("hidden-user-state"), false);
  assert.deepEqual(unsealPendingRequest<typeof state>(sealed, secret, 20 * 60_000, now + 1), state);
  assert.equal(unsealPendingRequest(sealed, "different-secret", 20 * 60_000), null);
  const corrupted = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-1);
  assert.equal(unsealPendingRequest(corrupted, secret, 20 * 60_000), null);
  assert.equal(unsealPendingRequest(sealed, secret, 20 * 60_000, now + 21 * 60_000), null);
});

test("consent form can complete after bridge OAuth instance restart", async () => {
  let oauth = new PersonalOAuthServer({ origin, ownerPassword: password, signingSecret: secret });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    if (!(await oauth.handle(req, res, url))) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Missing bind");
    const base = "http://127.0.0.1:" + addr.port;
    const callbackUrl = "https://chatgpt.com/connector_platform_oauth_redirect";
    const registered = await fetch(base + "/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [callbackUrl] }),
    });
    assert.equal(registered.status, 201);
    const clientId = ((await registered.json()) as { client_id: string }).client_id;
    const verifier = "X".repeat(48);
    const query = new URLSearchParams({
      client_id: clientId, redirect_uri: callbackUrl,
      response_type: "code", code_challenge: pkceS256(verifier),
      code_challenge_method: "S256", resource: origin + "/mcp/music", state: "back-from-restart",
    });
    const getForm = await fetch(base + "/oauth/authorize?" + query);
    assert.equal(getForm.status, 200);
    const requestId = (await getForm.text()).match(/name="request_id" value="([^"]+)"/)?.[1];
    assert.ok(requestId && requestId.startsWith("v1."));

    // Simulate Render replacing the Node process while the login page is open.
    oauth = new PersonalOAuthServer({ origin, ownerPassword: password, signingSecret: secret });

    const approval = await fetch(base + "/oauth/approve", {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, password }),
    });
    assert.equal(approval.status, 302);
    const callback = new URL(approval.headers.get("location") ?? "");
    assert.equal(callback.searchParams.get("state"), "back-from-restart");
    const code = callback.searchParams.get("code") ?? "";
    assert.ok(code);

    // Consent form should not be reusable within the same process.
    const replay = await fetch(base + "/oauth/approve", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, password }),
    });
    assert.equal(replay.status, 400);
    assert.equal(((await replay.json()) as { error: string }).error, "expired_request");

    const token = await fetch(base + "/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: clientId, redirect_uri: callbackUrl,
        code, code_verifier: verifier, resource: origin + "/mcp/music",
      }),
    });
    assert.equal(token.status, 200);
    const result = await token.json() as { access_token: string };
    assert.equal(oauth.isAuthorized("Bearer " + result.access_token, "/mcp/music"), true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
