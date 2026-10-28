import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { createAdapter } from '../server.mjs';

const BASE = 'https://coffee-adapter.example';
const CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const RESOURCE = `${BASE}/mcp`;
const ENV = {
  PUBLIC_BASE_URL: BASE,
  ADAPTER_SIGNING_KEY: 'mock-signing-key-for-local-tests-only-000000000',
  OWNER_LOGIN_SECRET: 'mock-owner-key-for-local-tests-only-1111111111',
  LUCKIN_TOKEN: 'mock-luckin-token-not-a-real-credential',
};
const sha = s => createHash('sha256').update(s).digest('base64url');

async function fixture(t, options = {}) {
  const calls = [];
  const diagnostics = [];
  const mockFetch = async (url, init) => {
    if (init.method === 'DELETE') {
      calls.push({ url, headers: init.headers, message: { method: 'DELETE' } });
      return new Response(null, { status: 204 });
    }
    const message = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, message });
    assert.equal(url, 'https://gwmcp.lkcoffee.com/order/user/mcp');
    assert.equal(init.headers.Authorization, `Bearer ${ENV.LUCKIN_TOKEN}`);
    assert.equal(init.redirect, 'error');
    if (options.upstreamStatus) return new Response(`mock secret echo: ${ENV.LUCKIN_TOKEN}`, { status: options.upstreamStatus });
    if (!Object.hasOwn(message, 'id')) return new Response(null, { status: 202 });
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'mock-only-luckin', version: 'test' } };
    } else if (message.method === 'tools/list') {
      if (options.discoveryError) return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'mock discovery failure' } });
      if (options.discoveryDelay) await new Promise(resolve => setTimeout(resolve, 20));
      const schema = { type: 'object', properties: { deptName: { type: 'string' }, longitude: { type: 'number' }, latitude: { type: 'number' } }, required: ['longitude', 'latitude'] };
      result = { tools: ['queryShopList', 'previewOrder', 'createOrder', 'cancelOrder', 'unknownFutureTool'].map(name => ({ name, inputSchema: schema, description: `MOCK ${name}` })) };
    } else if (message.method === 'tools/call') {
      result = { content: [{ type: 'text', text: JSON.stringify({ source: 'mock-only', echo: message.params.arguments, shouldBeRedacted: ENV.LUCKIN_TOKEN }) }] };
    } else result = {};
    const rpc = { jsonrpc: '2.0', id: message.id, result };
    if (options.sse && message.method === 'tools/list') {
      const text = `: mock heartbeat\r\n\r\nevent: message\r\ndata: ${JSON.stringify(rpc)}\r\n\r\n`;
      const bytes = new TextEncoder().encode(text);
      return new Response(new ReadableStream({ start(controller) {
        for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json(rpc, { headers: message.method === 'initialize' ? { 'mcp-session-id': 'mock-upstream-session' } : {} });
  };
  let clock = 1900000000;
  const env = { ...ENV, ...options.env };
  const adapter = createAdapter(env, { fetch: mockFetch, now: () => clock, diagnostic: event => diagnostics.push(event) });
  const server = http.createServer(adapter.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const local = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { headers = {}, json, form, ...rest } = {}) => fetch(local + path, {
    redirect: 'manual', ...rest,
    headers: { ...json !== undefined ? { 'content-type': 'application/json' } : {}, ...form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}, ...headers },
    ...json !== undefined ? { method: 'POST', body: JSON.stringify(json) } : {},
    ...form ? { method: 'POST', body: new URLSearchParams(form) } : {},
  });
  // fetch() overwrites Sec-Fetch-Mode with "cors". Use raw HTTP to represent
  // native browser form navigations with their actual Fetch Metadata headers.
  const rawRequest = (path, { headers = {}, form } = {}) => new Promise((resolve, reject) => {
    const payload = new URLSearchParams(form).toString();
    const r = http.request(local + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
      response.on('error', reject);
    });
    r.on('error', reject);
    r.end(payload);
  });
  const rpc = (method, params, access, session, id = 1) => request('/mcp', {
    headers: { accept: 'application/json, text/event-stream', ...access ? { authorization: `Bearer ${access}` } : {}, ...session ? { 'mcp-session-id': session } : {} },
    json: { jsonrpc: '2.0', id, method, params },
  });
  async function registration(redirect = CALLBACK) {
    const response = await request('/oauth/register', { json: { redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'] } });
    return { response, result: await response.json() };
  }
  async function authorization(overrides = {}) {
    const { result: c } = await registration();
    const verifier = randomBytes(32).toString('base64url');
    const query = { client_id: c.client_id, redirect_uri: CALLBACK, response_type: 'code', code_challenge_method: 'S256', code_challenge: sha(verifier), resource: RESOURCE, state: 'mock-state', scope: 'luckin:read', ...overrides };
    const page = await request('/oauth/authorize?' + new URLSearchParams(query));
    const html = await page.text();
    const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1];
    const cookie = page.headers.get('set-cookie')?.split(';')[0];
    return { page, html, ticket, cookie, verifier, clientId: c.client_id, query };
  }
  async function approvedCode(a = null) {
    a ||= await authorization();
    const approval = await request('/oauth/authorize', { headers: { origin: BASE, cookie: a.cookie }, form: { ticket: a.ticket, owner_secret: ENV.OWNER_LOGIN_SECRET } });
    assert.equal(approval.status, 303);
    const location = new URL(approval.headers.get('location'));
    assert.equal(location.origin, 'https://chatgpt.com');
    assert.equal(location.searchParams.get('state'), 'mock-state');
    assert.equal(location.searchParams.get('iss'), BASE);
    return { ...a, code: location.searchParams.get('code') };
  }
  async function exchange(a, overrides = {}) {
    return request('/oauth/token', { form: { grant_type: 'authorization_code', client_id: a.clientId, redirect_uri: CALLBACK, resource: RESOURCE, code_verifier: a.verifier, code: a.code, ...overrides } });
  }
  async function login() {
    const a = await approvedCode();
    const response = await exchange(a);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.scope, 'luckin:read');
    assert.equal(result.expires_in, 86400);
    assert.equal(result.refresh_token, undefined);
    return result.access_token;
  }
  async function initialize(access) {
    const response = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: { sampling: {} }, clientInfo: { name: 'mock-client', version: 'test' } }, access);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.result.serverInfo.name, 'mock-only-luckin');
    assert.deepEqual(result.result.capabilities, { tools: {} });
    assert.deepEqual(calls[0].message.params.capabilities, {});
    return response.headers.get('mcp-session-id');
  }
  return { request, rawRequest, rpc, registration, authorization, approvedCode, exchange, login, initialize, calls, diagnostics, verifyUpstream: adapter.verifyUpstream, tick: seconds => { clock += seconds; } };
}

test('connection diagnostics locate failed and successful stages without recording any credential or request data', async t => {
  const f = await fixture(t);
  const a = await f.authorization({ state: 'private-state-that-must-not-be-logged' });
  const wrong = await f.request('/oauth/authorize?private=do-not-log-this-query', {
    headers: { origin: BASE, cookie: a.cookie, 'x-private': 'do-not-log-this-header' },
    form: { ticket: a.ticket, owner_secret: ENV.OWNER_LOGIN_SECRET + '-wrong' },
  });
  assert.equal(wrong.status, 403);
  assert.ok(f.diagnostics.some(e => e.route === '/oauth/authorize' && e.stage === 'request_finished' && e.reason === 'owner_secret_mismatch'));
  const access = await f.login();
  const session = await f.initialize(access);
  assert.equal((await f.rpc('tools/list', {}, access, session)).status, 200);
  assert.equal((await f.rpc('tools/call', { name: 'queryShopList', arguments: { private: 'do-not-log-this-argument' } }, access, session)).status, 200);
  assert.ok(f.diagnostics.some(e => e.route === '/oauth/token' && e.status === 200));
  assert.ok(f.diagnostics.some(e => e.route === '/mcp' && e.rpc === 'tools/list' && e.status === 200));
  const logged = JSON.stringify(f.diagnostics);
  for (const secret of [a.ticket, a.cookie, a.clientId, a.verifier, access, ...Object.values(ENV), 'private-state-that-must-not-be-logged', 'do-not-log-this-query', 'do-not-log-this-header', 'do-not-log-this-argument']) {
    assert.ok(!logged.includes(secret), 'diagnostics must not contain request or credential data');
  }
  for (const event of f.diagnostics) {
    assert.ok(Object.keys(event).every(k => ['version', 'at', 'route', 'method', 'stage', 'origin', 'status', 'error', 'reason', 'rpc'].includes(k)));
  }
});

test('anonymous MCP access fails before upstream; discovery advertises PKCE and the exact resource', async t => {
  const f = await fixture(t);
  const r = await f.rpc('initialize', {}, null);
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  assert.equal(f.calls.length, 0);
  const metadata = await (await f.request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(metadata.resource, RESOURCE);
  const oauth = await (await f.request('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(oauth.code_challenge_methods_supported, ['S256']);
});

test('registration rejects attacker callbacks and authorization rejects wrong scope, audience and weak PKCE', async t => {
  const f = await fixture(t);
  for (const redirect of ['https://attacker.example/callback', 'https://chatgpt.com.attacker.example/connector_platform_oauth_redirect', CALLBACK + '?redirect=evil', 'http://chatgpt.com/connector_platform_oauth_redirect']) {
    assert.equal((await f.registration(redirect)).response.status, 400);
  }
  for (const overrides of [{ resource: 'https://attacker.example/mcp' }, { code_challenge_method: 'plain' }, { scope: 'luckin:write' }, { redirect_uri: 'https://attacker.example/' }]) {
    assert.equal((await f.authorization(overrides)).page.status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('owner login enforces same-origin form, CSRF cookie, password and one-time form', async t => {
  const f = await fixture(t);
  const a = await f.authorization();
  assert.equal(a.page.status, 200);
  assert.equal(a.page.headers.get('referrer-policy'), 'same-origin');
  assert.match(a.html, /不要填写瑞幸 Token/);
  for (const headers of [{}, { origin: BASE }, { origin: 'null', cookie: a.cookie }, { origin: 'https://attacker.example', cookie: a.cookie }]) {
    const r = await f.request('/oauth/authorize', { headers, form: { ticket: a.ticket, owner_secret: ENV.OWNER_LOGIN_SECRET } });
    assert.equal(r.status, 403);
  }
  const wrong = await f.request('/oauth/authorize', { headers: { origin: BASE, cookie: a.cookie }, form: { ticket: a.ticket, owner_secret: 'incorrect' } });
  assert.equal(wrong.status, 403);
  await f.approvedCode(a);
  const replay = await f.request('/oauth/authorize', { headers: { origin: BASE, cookie: a.cookie }, form: { ticket: a.ticket, owner_secret: ENV.OWNER_LOGIN_SECRET } });
  assert.equal(replay.status, 403);
});

test('cross-site and opaque browser navigations can open the OAuth form without granting MCP access', async t => {
  const f = await fixture(t);
  const a = await f.authorization();
  for (const origin of ['null', 'https://an-external-login.example']) {
    const response = await f.request('/oauth/authorize?' + new URLSearchParams(a.query), { headers: { origin } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /name="owner_secret"/);
    const mcp = await f.request('/mcp', { headers: { origin }, json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
    assert.equal(mcp.status, 403);
    assert.equal((await mcp.json()).error, 'invalid_origin');
  }
  assert.equal(f.calls.length, 0);
});

test('two authorization tabs retain independent CSRF cookies and can both be submitted', async t => {
  const f = await fixture(t);
  const first = await f.authorization();
  const second = await f.authorization();
  assert.notEqual(first.cookie.split('=')[0], second.cookie.split('=')[0]);
  const jar = first.cookie + '; ' + second.cookie;
  await f.approvedCode({ ...first, cookie: jar });
  await f.approvedCode({ ...second, cookie: jar });
});

test('a signed unexpired authorization form remains valid across a server restart', async t => {
  const before = await fixture(t);
  const a = await before.authorization();
  const after = await fixture(t);
  const approved = await after.approvedCode(a);
  assert.equal((await after.exchange(approved)).status, 200);
});

test('blocked cookies require exact same-origin native navigation and the correct owner password', async t => {
  const f = await fixture(t);
  const a = await f.authorization();
  const form = { ticket: a.ticket, owner_secret: ENV.OWNER_LOGIN_SECRET };
  for (const headers of [
    { origin: BASE },
    { origin: BASE, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
    { origin: BASE, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' },
    { origin: BASE, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    { origin: 'https://attacker.example', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
  ]) assert.equal((await f.rawRequest('/oauth/authorize', { headers, form })).status, 403);
  const headers = { origin: BASE, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' };
  const wrong = await f.rawRequest('/oauth/authorize', { headers, form: { ...form, owner_secret: 'incorrect' } });
  assert.equal((await wrong.json()).error, 'access_denied');
  assert.equal((await f.rawRequest('/oauth/authorize', { headers, form })).status, 303);
  assert.equal((await f.rawRequest('/oauth/authorize', { headers, form })).status, 403);
});

test('altered and expired signed forms cannot authorize, even with cookie-free navigation metadata', async t => {
  const f = await fixture(t);
  const a = await f.authorization();
  const headers = { origin: BASE, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' };
  const altered = a.ticket.slice(0, -1) + (a.ticket.endsWith('A') ? 'B' : 'A');
  const form = { ticket: altered, owner_secret: ENV.OWNER_LOGIN_SECRET };
  assert.equal((await f.rawRequest('/oauth/authorize', { headers, form })).status, 403);
  f.tick(601);
  assert.equal((await f.rawRequest('/oauth/authorize', { headers, form: { ...form, ticket: a.ticket } })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('authorization code cannot be replayed, exchanged with wrong PKCE or wrong resource', async t => {
  const f = await fixture(t);
  const a = await f.approvedCode();
  assert.equal((await f.exchange(a)).status, 200);
  assert.equal((await f.exchange(a)).status, 400);
  const b = await f.approvedCode();
  assert.equal((await f.exchange(b, { code_verifier: 'x'.repeat(43) })).status, 400);
  const c = await f.approvedCode();
  assert.equal((await f.exchange(c, { resource: 'https://attacker.example/mcp' })).status, 400);
  const d = await f.approvedCode();
  f.tick(121);
  assert.equal((await f.exchange(d)).status, 400);
});

test('real upstream schemas are preserved while writes and unknown tools are hidden and blocked', async t => {
  const f = await fixture(t);
  const access = await f.login();
  const session = await f.initialize(access);
  assert.notEqual(session, 'mock-upstream-session');
  const listing = await f.rpc('tools/list', {}, access, session);
  assert.equal(listing.status, 200);
  const tools = (await listing.json()).result.tools;
  assert.deepEqual(tools.map(t => t.name), ['queryShopList', 'previewOrder']);
  assert.deepEqual(tools[0].inputSchema.required, ['longitude', 'latitude']);
  assert.deepEqual(tools[0].securitySchemes, [{ type: 'oauth2', scopes: ['luckin:read'] }]);
  for (const name of ['createOrder', 'cancelOrder', 'unknownFutureTool']) {
    const r = await f.rpc('tools/call', { name, arguments: { userConfirmed: true } }, access, session);
    assert.equal(r.status, 403);
  }
  assert.equal(f.calls.length, 2);
  const args = { longitude: 120.123, latitude: 30.456, deptName: 'mock shop' };
  const result = await f.rpc('tools/call', { name: 'queryShopList', arguments: args }, access, session);
  assert.equal(result.status, 200);
  const text = await result.text();
  assert.ok(text.includes('mock-only'));
  assert.ok(!text.includes(ENV.LUCKIN_TOKEN));
  assert.ok(text.includes('[REDACTED]'));
  assert.deepEqual(f.calls.at(-1).message.params.arguments, args);
  assert.equal(f.calls.at(-1).headers['Mcp-Session-Id'], 'mock-upstream-session');
  assert.notEqual(f.calls.at(-1).headers.Authorization, `Bearer ${access}`);
});

test('a client with cached tool schemas can query in a new session after automatic real upstream discovery', async t => {
  const f = await fixture(t);
  const access = await f.login();
  const session = await f.initialize(access);
  for (const name of ['createOrder', 'cancelOrder', 'unknownFutureTool']) {
    assert.equal((await f.rpc('tools/call', { name, arguments: {} }, access, session)).status, 403);
  }
  assert.equal(f.calls.length, 1, 'blocked writes cannot even start discovery');
  const args = { longitude: 121.393459, latitude: 31.315814 };
  const first = await f.rpc('tools/call', { name: 'queryShopList', arguments: args }, access, session);
  assert.equal(first.status, 200);
  assert.deepEqual(f.calls.map(c => c.message.method), ['initialize', 'tools/list', 'tools/call']);
  assert.deepEqual(f.calls.at(-1).message.params.arguments, args);
  assert.equal((await f.rpc('tools/call', { name: 'queryShopList', arguments: args }, access, session)).status, 200);
  assert.equal(f.calls.filter(c => c.message.method === 'tools/list').length, 1);
  const count = f.calls.length;
  assert.equal((await f.rpc('tools/call', { name: 'searchProductForMcp', arguments: {} }, access, session)).status, 400);
  assert.equal(f.calls.length, count, 'a safe name absent from the real upstream list is still blocked');
  const nextSession = await f.initialize(access);
  assert.equal((await f.rpc('tools/call', { name: 'queryShopList', arguments: args }, access, nextSession)).status, 200);
  assert.equal(f.calls.filter(c => c.message.method === 'tools/list').length, 2);
});

test('concurrent first tool calls share discovery and each query is forwarded exactly once', async t => {
  const f = await fixture(t, { discoveryDelay: true });
  const access = await f.login();
  const session = await f.initialize(access);
  const responses = await Promise.all([1, 2].map(id => f.rpc('tools/call', { name: 'queryShopList', arguments: { marker: id } }, access, session, id)));
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal(f.calls.filter(c => c.message.method === 'tools/list').length, 1);
  assert.deepEqual(f.calls.filter(c => c.message.method === 'tools/call').map(c => c.message.params.arguments.marker).sort(), [1, 2]);
});

test('failed automatic discovery returns an upstream failure without invoking the requested tool', async t => {
  const f = await fixture(t, { discoveryError: true });
  const access = await f.login();
  const session = await f.initialize(access);
  const r = await f.rpc('tools/call', { name: 'queryShopList', arguments: {} }, access, session);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error.data.adapterCode, 'upstream_tools_failed');
  assert.deepEqual(f.calls.map(c => c.message.method), ['initialize', 'tools/list']);
});

test('session IDs are isolated across separately authorized connections', async t => {
  const f = await fixture(t);
  const ownerA = await f.login();
  const sid = await f.initialize(ownerA);
  const ownerB = await f.login();
  assert.equal((await f.rpc('tools/list', {}, ownerB, sid)).status, 404);
  assert.equal(f.calls.length, 1);
});

test('fragmented SSE upstream tool discovery is supported', async t => {
  const f = await fixture(t, { sse: true });
  const access = await f.login();
  const sid = await f.initialize(access);
  const response = await f.rpc('tools/list', {}, access, sid);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.tools.length, 2);
});

test('upstream authentication failure is reported without exposing secrets or substituting OAuth credentials', async t => {
  const f = await fixture(t, { upstreamStatus: 401 });
  const access = await f.login();
  const response = await f.rpc('initialize', { protocolVersion: '2025-03-26' }, access);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('www-authenticate'), null);
  const text = await response.text();
  assert.match(text, /HTTP 401/);
  for (const v of Object.values(ENV).slice(1)) assert.ok(!text.includes(v));
  assert.equal(f.calls.length, 1);
});

test('missing or malformed protected configuration fails closed', async t => {
  for (const env of [{ ADAPTER_SIGNING_KEY: '' }, { OWNER_LOGIN_SECRET: 'weak' }, { PUBLIC_BASE_URL: 'http://public.example' }]) {
    const f = await fixture(t, { env });
    assert.equal((await f.request('/.well-known/oauth-authorization-server')).status, 503);
    assert.equal(f.calls.length, 0);
  }
  for (const value of ['', 'Bearer `REDACTED` ', 'bad token', 'token\nwith-newline']) {
    const f = await fixture(t, { env: { LUCKIN_TOKEN: value } });
    const access = await f.login();
    const response = await f.rpc('initialize', { protocolVersion: '2025-03-26' }, access);
    assert.equal(response.status, 503);
    assert.equal(f.calls.length, 0);
  }
});

test('tokens expire; forged tokens and invalid Origin are rejected', async t => {
  const f = await fixture(t);
  const access = await f.login();
  const forged = access.slice(0, -1) + (access.endsWith('A') ? 'B' : 'A');
  assert.equal((await f.rpc('initialize', {}, forged)).status, 401);
  f.tick(86401);
  assert.equal((await f.rpc('initialize', {}, access)).status, 401);
  const origin = await f.request('/mcp', { headers: { origin: 'https://attacker.example' }, json: {} });
  assert.equal(origin.status, 403);
  assert.equal(f.calls.length, 0);
});

test('startup check discovers actual upstream definitions without calling tools or reporting credentials', async t => {
  const f = await fixture(t);
  const report = await f.verifyUpstream();
  assert.equal(report.ok, true);
  assert.deepEqual(f.calls.map(c => c.message.method), ['initialize', 'notifications/initialized', 'tools/list', 'DELETE']);
  assert.equal(report.tools.find(t => t.name === 'createOrder').exposed, false);
  assert.deepEqual(report.tools.find(t => t.name === 'queryShopList').required, ['longitude', 'latitude']);
  for (const secret of [ENV.LUCKIN_TOKEN, ENV.OWNER_LOGIN_SECRET, ENV.ADAPTER_SIGNING_KEY]) assert.ok(!JSON.stringify(report).includes(secret));
});

test('startup check reports failed Luckin authorization and does not fabricate a tool list', async t => {
  const f = await fixture(t, { upstreamStatus: 401 });
  const report = await f.verifyUpstream();
  assert.equal(report.ok, false);
  assert.equal(report.code, 'upstream_auth_failed');
  assert.equal(report.tools, undefined);
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(report).includes(ENV.LUCKIN_TOKEN));
});
