import http from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const OFFICIAL_URL = 'https://gwmcp.lkcoffee.com/order/user/mcp';
const SCOPE = 'luckin:read';
const SAFE_TOOLS = new Set([
  'queryShopList', 'searchProductForMcp', 'switchProduct',
  'queryProductDetailInfo', 'previewOrder', 'queryOrderDetailInfo',
]);
const MAX_BODY = 64 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
const equal = (a, b) => timingSafeEqual(Buffer.from(hash(String(a))), Buffer.from(hash(String(b))));
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

class Failure extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function requireThat(ok, status, code, message) {
  if (!ok) throw new Failure(status, code, message);
}

export function createAdapter(env = process.env, injected = {}) {
  const base = (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  let validBase = false;
  try {
    const u = new URL(base);
    validBase = u.origin === base && !u.username && !u.password &&
      (u.protocol === 'https:' || (env.NODE_ENV === 'test' && u.hostname === '127.0.0.1'));
  } catch { /* fail closed until explicitly configured */ }
  const resource = `${base}/mcp`;
  const key = env.ADAPTER_SIGNING_KEY || '';
  const ownerSecret = env.OWNER_LOGIN_SECRET || '';
  const token = (env.LUCKIN_TOKEN || '').trim().replace(/^Bearer\s+/i, '').trim();
  const tokenReady = !!token && !/[\s`"\\<>]/.test(token) && !/REDACTED|YOUR_TOKEN|REPLACE_ME/i.test(token);
  const authReady = validBase && key.length >= 32 && ownerSecret.length >= 32 && key !== ownerSecret;
  const fetchUpstream = injected.fetch || fetch;
  const now = injected.now || (() => Math.floor(Date.now() / 1000));
  const boot = random();
  const usedForms = new Map();
  const codes = new Map();
  const sessions = new Map();
  const buckets = new Map();

  function seal(kind, payload) {
    const data = Buffer.from(JSON.stringify({ ...payload, kind, iss: base })).toString('base64url');
    const sig = createHmac('sha256', key).update(data).digest('base64url');
    return `${data}.${sig}`;
  }
  function unseal(value, kind) {
    requireThat(typeof value === 'string' && value.length <= 12000, 401, 'invalid_token', 'Invalid credential.');
    const [data, sig, extra] = value.split('.');
    requireThat(data && sig && !extra && equal(sig, createHmac('sha256', key).update(data).digest('base64url')), 401, 'invalid_token', 'Invalid credential.');
    let p;
    try { p = JSON.parse(Buffer.from(data, 'base64url')); } catch { throw new Failure(401, 'invalid_token', 'Invalid credential.'); }
    requireThat(p.kind === kind && p.iss === base && (!p.exp || p.exp > now()), 401, 'invalid_token', 'Expired or invalid credential.');
    return p;
  }
  function limit(name, max, seconds) {
    const old = buckets.get(name);
    const b = old && old.until > now() ? old : { count: 0, until: now() + seconds };
    b.count++;
    buckets.set(name, b);
    requireThat(b.count <= max, 429, 'rate_limited', 'Please try again later.');
  }
  function clean() {
    for (const map of [usedForms, codes, sessions]) {
      for (const [id, record] of map) if (record.exp <= now()) map.delete(id);
    }
    for (const [id, record] of buckets) if (record.until <= now()) buckets.delete(id);
  }
  function redact(value) {
    if (typeof value === 'string') {
      for (const secret of [token, key, ownerSecret]) if (secret) value = value.split(secret).join('[REDACTED]');
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
    return value;
  }
  function json(res, status, value, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(JSON.stringify(redact(value)));
  }
  function html(res, title, content, headers = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      // Chromium applies form-action to the redirect after a successful POST,
      // so the verified OAuth callback host must also be permitted here.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
      // A no-referrer policy turns the Origin of native form POSTs into
      // "null". Same-origin retains the login form's origin without sending
      // referrers to an external OAuth callback.
      'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', ...headers,
    });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;background:#f2f6fb;color:#21324a;margin:0;padding:36px 18px}main{max-width:520px;margin:6vh auto;background:white;border-radius:24px;padding:28px;box-shadow:0 12px 45px #24446612}h1{font-size:24px}input,button{box-sizing:border-box;width:100%;padding:14px;border-radius:12px;font:inherit;margin-top:12px}input{border:1px solid #cdd8e6}button{border:0;background:#235d99;color:white}small{color:#596c83}</style><main>${content}</main></html>`);
  }
  async function body(req, type) {
    requireThat((req.headers['content-type'] || '').split(';')[0].toLowerCase() === type, 415, 'invalid_request', 'Unsupported Content-Type.');
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      requireThat(size <= MAX_BODY, 413, 'invalid_request', 'Request too large.');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString();
    try {
      if (type === 'application/json') return JSON.parse(text);
      const params = new URLSearchParams(text);
      for (const k of params.keys()) requireThat(params.getAll(k).length === 1, 400, 'invalid_request', 'Duplicate parameter.');
      return Object.fromEntries(params);
    } catch (e) { if (e instanceof Failure) throw e; throw new Failure(400, 'invalid_request', 'Invalid request body.'); }
  }
  function validRedirect(value) {
    try {
      const u = new URL(value);
      return u.origin === 'https://chatgpt.com' && !u.username && !u.password && !u.search && !u.hash &&
        (u.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname));
    } catch { return false; }
  }
  function client(id) {
    try {
      const c = unseal(id, 'client');
      requireThat(Array.isArray(c.redirect_uris) && c.redirect_uris.every(validRedirect), 400, 'invalid_client', 'Invalid client.');
      return c;
    } catch { throw new Failure(400, 'invalid_client', 'Client registration is not valid for this adapter.'); }
  }
  function authRequest(p) {
    const c = client(p.client_id);
    requireThat(c.redirect_uris.includes(p.redirect_uri), 400, 'invalid_request', 'Unregistered redirect URI.');
    requireThat(p.response_type === 'code' && p.code_challenge_method === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(p.code_challenge || ''), 400, 'invalid_request', 'Authorization code with PKCE S256 is required.');
    requireThat(p.resource === resource, 400, 'invalid_target', 'Wrong OAuth resource.');
    requireThat(!p.scope || p.scope === SCOPE, 400, 'invalid_scope', 'Only read scope is currently available.');
    requireThat(typeof p.state === 'string' && p.state.length > 0 && p.state.length <= 2048, 400, 'invalid_request', 'OAuth state is required.');
    return { client_id: p.client_id, redirect_uri: p.redirect_uri, resource, scope: SCOPE, state: p.state, code_challenge: p.code_challenge };
  }
  function cookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=').slice(0, 2)));
  }
  function bearer(req) {
    const h = req.headers.authorization || '';
    requireThat(h.startsWith('Bearer '), 401, 'invalid_token', 'Connect this adapter using OAuth first.');
    const p = unseal(h.slice(7), 'access');
    requireThat(p.aud === resource && p.sub === 'owner' && p.scope === SCOPE && typeof p.jti === 'string', 401, 'invalid_token', 'Invalid token audience or scope.');
    return p;
  }
  async function readResponse(response, id) {
    requireThat(response.body, 502, 'upstream_protocol_error', 'Empty upstream response.');
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let size = 0, text = '';
    const sse = (response.headers.get('content-type') || '').includes('text/event-stream');
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        requireThat(size <= MAX_RESPONSE, 502, 'upstream_protocol_error', 'Upstream response too large.');
        text += decoder.decode(value, { stream: true });
        if (sse) {
          text = text.replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = text.indexOf('\n\n')) !== -1) {
            const event = text.slice(0, boundary); text = text.slice(boundary + 2);
            const data = event.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
            if (!data) continue;
            let message; try { message = JSON.parse(data); } catch { continue; }
            if (message.jsonrpc === '2.0' && message.id === id) return message;
          }
        }
      }
      if (!sse) {
        let message; try { message = JSON.parse(text); } catch { throw new Failure(502, 'upstream_protocol_error', 'Upstream did not return JSON-RPC.'); }
        requireThat(message.jsonrpc === '2.0' && message.id === id, 502, 'upstream_protocol_error', 'Upstream response ID mismatch.');
        return message;
      }
      throw new Failure(502, 'upstream_protocol_error', 'Upstream stream ended before the requested response.');
    } finally { await reader.cancel().catch(() => {}); }
  }
  async function upstream(message, session) {
    requireThat(tokenReady, 503, 'setup_required', 'LUCKIN_TOKEN must be set in the protected Render Environment screen.');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (session?.upstreamId) headers['Mcp-Session-Id'] = session.upstreamId;
    if (session?.protocol) headers['MCP-Protocol-Version'] = session.protocol;
    let response;
    try { response = await fetchUpstream(OFFICIAL_URL, { method: 'POST', headers, body: JSON.stringify(message), redirect: 'error', signal: AbortSignal.timeout(25000) }); }
    catch { throw new Failure(502, 'upstream_unavailable', '瑞幸连接失败或超时；本次请求没有自动重试。'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      requireThat(response.status !== 401 && response.status !== 403, 502, 'upstream_auth_failed', `瑞幸授权校验失败（HTTP ${response.status}）。请在服务端更新瑞幸 Token；不要将它填入 ChatGPT OAuth 字段。`);
      throw new Failure(502, 'upstream_http_error', `瑞幸接口返回 HTTP ${response.status}；本次请求没有自动重试。`);
    }
    if (message.id === undefined) { await response.body?.cancel().catch(() => {}); return { accepted: true }; }
    let result;
    try { result = await readResponse(response, message.id); }
    catch (e) {
      if (e instanceof Failure) throw e;
      throw new Failure(502, 'upstream_unavailable', '瑞幸响应读取失败或超时；本次请求没有自动重试。');
    }
    return { message: result, upstreamId: response.headers.get('mcp-session-id') };
  }

  // Runs only at process startup. Credentials stay inside this process;
  // diagnostics never execute tools/call or inspect private order data.
  async function verifyUpstream() {
    let session;
    try {
      requireThat(authReady && tokenReady, 503, 'setup_required', 'Protected configuration is incomplete.');
      const initialized = await upstream({ jsonrpc: '2.0', id: 91001, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'xlc-luckin-startup-check', version: '0.1.0' },
      } });
      requireThat(!initialized.message.error && typeof initialized.message.result?.protocolVersion === 'string', 502, 'upstream_initialize_failed', 'Luckin MCP initialization failed.');
      session = { upstreamId: initialized.upstreamId, protocol: initialized.message.result.protocolVersion };
      await upstream({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
      const listing = await upstream({ jsonrpc: '2.0', id: 91002, method: 'tools/list', params: {} }, session);
      requireThat(!listing.message.error && Array.isArray(listing.message.result?.tools), 502, 'upstream_tools_failed', 'Luckin tool discovery failed.');
      const tools = listing.message.result.tools.map(t => ({
        name: t.name,
        required: Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : [],
        exposed: SAFE_TOOLS.has(t.name),
      }));
      return redact({ ok: true, checkedAt: new Date(now() * 1000).toISOString(), protocol: session.protocol, tools });
    } catch (e) {
      return { ok: false, checkedAt: new Date(now() * 1000).toISOString(), code: e instanceof Failure ? e.code : 'self_check_failed', message: e instanceof Failure ? e.message : 'Startup connection check failed.' };
    } finally {
      if (session?.upstreamId) {
        try {
          const closed = await fetchUpstream(OFFICIAL_URL, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(5000), headers: {
            Authorization: `Bearer ${token}`, 'Mcp-Session-Id': session.upstreamId, 'MCP-Protocol-Version': session.protocol,
          } });
          await closed.body?.cancel().catch(() => {});
        } catch { /* Cleanup is best effort and never retried. */ }
      }
    }
  }

  async function handle(req, res) {
    let message;
    try {
      clean();
      const url = new URL(req.url, validBase ? base : 'https://unconfigured.invalid');
      const origin = req.headers.origin;
      // OAuth authorization pages and public discovery must be reachable by
      // cross-site browser navigations, including opaque redirect origins.
      // MCP transport and mutation endpoints retain their Origin restriction.
      const publicNavigation = req.method === 'GET' && url.pathname !== '/mcp';
      requireThat(publicNavigation || !origin || [base, 'https://chatgpt.com'].includes(origin), 403, 'invalid_origin', 'Origin not allowed.');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', mode: 'read-only', configured: authReady && tokenReady });
      if (req.method === 'GET' && url.pathname === '/') return html(res, '谢临川 · 瑞幸连接', `<h1>谢临川 · 瑞幸连接</h1><p>${authReady && tokenReady ? '配置已填写，等待 ChatGPT OAuth 连接及真实接口验证。' : '等待管理员在 Render 的 Environment 页面填写凭据。'}</p><p>当前阶段只开放查询与订单预览。创建和取消订单均已禁用。</p><small>此页面不会索取瑞幸 Token，也不会创建订单。</small>`);
      requireThat(authReady, 503, 'setup_required', 'Configure the adapter URL and two independent secrets in Render first.');
      if (req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) {
        return json(res, 200, { resource, authorization_servers: [base], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: '谢临川 · 瑞幸咖啡（查询）' });
      }
      if (req.method === 'GET' && ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'].includes(url.pathname)) {
        return json(res, 200, { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: [SCOPE], authorization_response_iss_parameter_supported: true });
      }
      if (req.method === 'POST' && url.pathname === '/oauth/register') {
        limit('register', 100, 3600);
        const p = await body(req, 'application/json');
        requireThat(Array.isArray(p.redirect_uris) && p.redirect_uris.length > 0 && p.redirect_uris.length <= 5 && p.redirect_uris.every(validRedirect), 400, 'invalid_redirect_uri', 'Only exact ChatGPT production callback URLs are permitted.');
        requireThat(!p.token_endpoint_auth_method || p.token_endpoint_auth_method === 'none', 400, 'invalid_client_metadata', 'Use public-client PKCE authentication.');
        const redirects = [...new Set(p.redirect_uris)];
        return json(res, 201, { client_id: seal('client', { redirect_uris: redirects, nonce: random() }), client_id_issued_at: now(), redirect_uris: redirects, response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none', scope: SCOPE });
      }
      if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
        limit('authorize', 100, 600);
        for (const k of url.searchParams.keys()) requireThat(url.searchParams.getAll(k).length === 1, 400, 'invalid_request', 'Duplicate parameter.');
        const p = authRequest(Object.fromEntries(url.searchParams));
        const csrf = random(), nonce = random();
        // Signed form state survives a process restart. Each flow has its own
        // host-only cookie so concurrent authorization tabs do not overwrite it.
        const ticket = seal('authorization_form', { request: p, csrf: hash(csrf), nonce, exp: now() + 600 });
        return html(res, '授权谢临川查询瑞幸', `<h1>连接你的瑞幸咖啡</h1><p>授权 ChatGPT 查询门店、商品、订单，并预览价格。</p><p><strong>本阶段不能创建或取消订单。</strong></p><form method="post" action="/oauth/authorize"><input type="hidden" name="ticket" value="${ticket}"><label>连接口令<input type="password" name="owner_secret" required autocomplete="current-password" minlength="32" maxlength="256"></label><small>仅填写此服务的 OWNER_LOGIN_SECRET。不要填写瑞幸 Token、短信验证码或支付密码。</small><button type="submit">确认授权查询</button></form>`, { 'Set-Cookie': `xlc_oauth_csrf_${nonce}=${csrf}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600` });
      }
      if (req.method === 'POST' && url.pathname === '/oauth/authorize') {
        requireThat(origin === base, 403, 'invalid_origin', 'Authorization must be submitted from this site.');
        limit('owner-login', 15, 600);
        const p = await body(req, 'application/x-www-form-urlencoded');
        let form;
        try { form = unseal(p.ticket, 'authorization_form'); }
        catch { throw new Failure(403, 'invalid_request', '授权页面已失效，请返回 ChatGPT 重新连接。'); }
        requireThat(typeof form.nonce === 'string' && !usedForms.has(form.nonce), 403, 'invalid_request', '这次授权已经提交，请返回 ChatGPT 查看连接状态。');
        const cookieName = `xlc_oauth_csrf_${form.nonce}`;
        const cookie = cookies(req)[cookieName];
        const cookieMatches = !!cookie && equal(form.csrf, hash(cookie));
        // Modern browsers may block cookies in an embedded login flow. Only
        // an explicitly same-origin native form navigation may use the signed
        // ticket without a cookie. Origin, Fetch Metadata, the owner password,
        // expiration and one-time nonce are still checked independently.
        const trustedNavigation = !cookie && req.headers['sec-fetch-site'] === 'same-origin' && req.headers['sec-fetch-mode'] === 'navigate';
        requireThat(cookieMatches || trustedNavigation, 403, 'invalid_request', '浏览器未能验证这次授权页面，请从 ChatGPT 在新标签页重新打开授权。');
        requireThat(equal(p.owner_secret || '', ownerSecret), 403, 'access_denied', '连接口令不正确。');
        usedForms.set(form.nonce, { exp: form.exp });
        const code = random();
        codes.set(code, { ...form.request, exp: now() + 120 });
        console.info('LUCKIN_OAUTH_STAGE', JSON.stringify({ stage: 'authorization_code_issued', at: new Date(now() * 1000).toISOString() }));
        const destination = new URL(form.request.redirect_uri);
        destination.searchParams.set('code', code);
        destination.searchParams.set('state', form.request.state);
        destination.searchParams.set('iss', base);
        res.writeHead(303, { Location: destination.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Set-Cookie': `${cookieName}=; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        limit('token', 300, 600);
        const p = await body(req, 'application/x-www-form-urlencoded');
        client(p.client_id);
        requireThat(p.grant_type === 'authorization_code', 400, 'unsupported_grant_type', 'Only authorization_code is supported.');
        const c = codes.get(p.code);
        requireThat(c && c.exp > now(), 400, 'invalid_grant', 'Expired or used authorization code.');
        codes.delete(p.code);
        requireThat(c.client_id === p.client_id && c.redirect_uri === p.redirect_uri && p.resource === resource, 400, 'invalid_grant', 'Authorization code binding mismatch.');
        requireThat(/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier || '') && equal(hash(p.code_verifier), c.code_challenge), 400, 'invalid_grant', 'Invalid PKCE verifier.');
        const ttl = 86400;
        const access = seal('access', { aud: resource, sub: 'owner', scope: SCOPE, client_id: p.client_id, jti: random(), iat: now(), exp: now() + ttl });
        console.info('LUCKIN_OAUTH_STAGE', JSON.stringify({ stage: 'access_token_issued', at: new Date(now() * 1000).toISOString() }));
        // No reusable non-rotating refresh credentials. Reconnect after expiry.
        return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: ttl, scope: SCOPE });
      }
      if (url.pathname !== '/mcp') throw new Failure(404, 'not_found', 'Not found.');
      const principal = bearer(req);
      limit(`mcp:${principal.jti}`, 600, 600);
      if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST, DELETE' }); return res.end(); }
      if (req.method === 'DELETE') {
        const sid = req.headers['mcp-session-id'];
        const s = sessions.get(sid);
        requireThat(s && s.owner === principal.jti, 404, 'session_not_found', 'Reinitialize the MCP session.');
        sessions.delete(sid); res.writeHead(204); return res.end();
      }
      requireThat(req.method === 'POST', 405, 'invalid_request', 'Use POST.');
      requireThat((req.headers.accept || '').includes('application/json') && (req.headers.accept || '').includes('text/event-stream'), 406, 'invalid_request', 'Accept must include application/json and text/event-stream.');
      message = await body(req, 'application/json');
      requireThat(message && !Array.isArray(message) && message.jsonrpc === '2.0' && typeof message.method === 'string', 400, 'invalid_request', 'Expected one JSON-RPC 2.0 request.');
      const hasId = Object.hasOwn(message, 'id');
      requireThat(!hasId || typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id)), 400, 'invalid_request', 'Invalid JSON-RPC ID.');
      requireThat(hasId || message.method === 'notifications/initialized', 400, 'invalid_request', 'Only initialized notifications are supported.');
      if (message.method === 'initialize') {
        requireThat(!req.headers['mcp-session-id'] && sessions.size < 100, 400, 'invalid_request', 'Start a fresh MCP session.');
        requireThat(message.params && typeof message.params.protocolVersion === 'string', 400, 'invalid_request', 'Missing MCP protocol version.');
        const outbound = { ...message, params: { ...message.params, capabilities: {} } };
        const result = await upstream(outbound);
        if (result.message.error) return json(res, 200, result.message);
        requireThat(typeof result.message.result?.protocolVersion === 'string', 502, 'upstream_protocol_error', 'Missing upstream protocol version.');
        const sid = random();
        sessions.set(sid, { owner: principal.jti, upstreamId: result.upstreamId, protocol: result.message.result.protocolVersion, tools: new Set(), exp: now() + 28800, boot });
        result.message.result.capabilities = { tools: {} };
        result.message.result.instructions = '当前适配服务仅开放查询和非约束性订单预览；禁止创建或取消订单。不得编造瑞幸查询结果。';
        return json(res, 200, result.message, { 'Mcp-Session-Id': sid });
      }
      const sid = req.headers['mcp-session-id'];
      const session = sessions.get(sid);
      requireThat(session && session.owner === principal.jti && session.exp > now(), 404, 'session_not_found', 'Reinitialize the MCP session.');
      requireThat(!req.headers['mcp-protocol-version'] || req.headers['mcp-protocol-version'] === session.protocol, 400, 'invalid_request', 'MCP protocol version mismatch.');
      if (message.method === 'tools/call') {
        const name = message.params?.name;
        requireThat(SAFE_TOOLS.has(name), 403, 'write_disabled', '创建、取消及未知工具均未开放；必须先完成真实查询验收与交易确认接入。');
        requireThat(session.tools.has(name), 400, 'tool_not_discovered', 'Call tools/list first; only tools actually returned by Luckin may be called.');
      } else requireThat(['tools/list', 'ping', 'notifications/initialized'].includes(message.method), 400, 'method_not_allowed', 'This adapter only proxies the ordering tool protocol.');
      const result = await upstream(message, session);
      if (result.accepted) { res.writeHead(202, { 'Cache-Control': 'no-store' }); return res.end(); }
      if (message.method === 'tools/list' && !result.message.error) {
        requireThat(Array.isArray(result.message.result?.tools), 502, 'upstream_protocol_error', 'Missing upstream tool list.');
        result.message.result.tools = result.message.result.tools.filter(t => SAFE_TOOLS.has(t.name)).map(t => {
          session.tools.add(t.name);
          const schemes = [{ type: 'oauth2', scopes: [SCOPE] }];
          return { ...t, annotations: { ...t.annotations, readOnlyHint: true, destructiveHint: false }, securitySchemes: schemes, _meta: { ...t._meta, securitySchemes: schemes } };
        });
      }
      return json(res, 200, result.message);
    } catch (error) {
      const e = error instanceof Failure ? error : new Failure(500, 'internal_error', 'Unexpected adapter error.');
      const headers = e.status === 401 ? { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", error="invalid_token"` } : {};
      if (message && Object.hasOwn(message, 'id')) return json(res, e.status, { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: e.message, data: { adapterCode: e.code } } }, headers);
      return json(res, e.status, { error: e.code, error_description: e.message }, headers);
    }
  }
  return { handle, verifyUpstream };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const adapter = createAdapter();
  const server = http.createServer(adapter.handle);
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => {
    console.log('Luckin adapter started in read-only mode.');
    void adapter.verifyUpstream().then(report => console.log('LUCKIN_CONNECTION_CHECK', JSON.stringify(report)));
  });
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); });
}
