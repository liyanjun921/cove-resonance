import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PersonalOAuthServer, pkceS256, validateRedirect } from "../src/oauth.js";

const origin = "https://cove.example.test";
const ownerPassword = "some-very-long-owner-password";
const signingSecret = "f".repeat(48);

test("redirect URLs must be https or local development loopback", () => {
  assert.equal(validateRedirect("https://chatgpt.com/connector_platform_oauth_redirect"), true);
  assert.equal(validateRedirect("http://localhost:5000/callback"), true);
  assert.equal(validateRedirect("https://user:pass@example.com/path"), false);
  assert.equal(validateRedirect("http://evil.example/callback"), false);
  assert.equal(validateRedirect("https://example.com/a#frag"), false);
  assert.equal(validateRedirect("javascript:alert(1)"), false);
});

test("OAuth mode fails closed unless HTTPS + owner credentials are configured", () => {
  assert.equal(new PersonalOAuthServer({ origin, ownerPassword: "", signingSecret }).enabled, false);
  assert.equal(new PersonalOAuthServer({ origin: "http://localhost:8787", ownerPassword, signingSecret }).enabled, false);
  assert.equal(new PersonalOAuthServer({ origin, ownerPassword, signingSecret }).enabled, true);
});

test("single-owner OAuth PKCE flow authorizes only the requested MCP resource", async () => {
  const oauth = new PersonalOAuthServer({ origin, ownerPassword, signingSecret });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    if (!(await oauth.handle(req, res, url))) { res.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const info = server.address();
    if (!info || typeof info === "string") throw new Error("no listener");
    const base = "http://127.0.0.1:" + info.port;
    const metadata = await fetch(base + "/.well-known/oauth-authorization-server");
    assert.equal(metadata.status, 200);
    const meta = await metadata.json() as Record<string, string>;
    assert.equal(meta.issuer, origin);
    const resourceMeta = await (await fetch(base + "/.well-known/oauth-protected-resource/mcp/music")).json() as { resource: string };
    assert.equal(resourceMeta.resource, origin + "/mcp/music");

    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const register = await fetch(base + "/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
    });
    assert.equal(register.status, 201);
    const client = await register.json() as { client_id: string };
    const verifier = "X".repeat(48);
    const params = new URLSearchParams({
      client_id: client.client_id, redirect_uri: redirectUri,
      response_type: "code", code_challenge: pkceS256(verifier),
      code_challenge_method: "S256", resource: origin + "/mcp/music", state: "safe-state",
    });
    const authorize = await fetch(base + "/oauth/authorize?" + params);
    assert.equal(authorize.status, 200);
    const html = await authorize.text();
    const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1];
    assert.ok(requestId);
    const wrongPassword = await fetch(base + "/oauth/approve", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, password: "not-the-password" }),
    });
    assert.equal(wrongPassword.status, 200);
    assert.match(await wrongPassword.text(), /Incorrect password/);
    const approval = await fetch(base + "/oauth/approve", {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, password: ownerPassword }),
    });
    assert.equal(approval.status, 302);
    const callback = new URL(approval.headers.get("location") ?? "");
    assert.equal(callback.searchParams.get("state"), "safe-state");
    const code = callback.searchParams.get("code");
    assert.ok(code);

    const token = await fetch(base + "/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id,
        redirect_uri: redirectUri, code, code_verifier: verifier, resource: origin + "/mcp/music" }),
    });
    assert.equal(token.status, 200);
    const tokenBody = await token.json() as { access_token: string; refresh_token: string };
    assert.equal(oauth.isAuthorized("Bearer " + tokenBody.access_token, "/mcp/music"), true);
    assert.equal(oauth.isAuthorized("Bearer " + tokenBody.access_token, "/mcp"), false);
    assert.equal(oauth.isAuthorized("Bearer wrong", "/mcp/music"), false);

    const replay = await fetch(base + "/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id,
        redirect_uri: redirectUri, code, code_verifier: verifier }),
    });
    assert.equal(replay.status, 400);

    const refresh = await fetch(base + "/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id,
        refresh_token: tokenBody.refresh_token }),
    });
    assert.equal(refresh.status, 200);
    const refreshedBody = await refresh.json() as { access_token: string };
    assert.equal(oauth.isAuthorized("Bearer " + refreshedBody.access_token, "/mcp/music"), true);
    const refreshReplay = await fetch(base + "/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id,
        refresh_token: tokenBody.refresh_token }),
    });
    assert.equal(refreshReplay.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
