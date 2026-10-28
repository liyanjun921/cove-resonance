// Optional browser regression. Uses only local mock credentials and intercepts
// the ChatGPT callback; it never connects to a user's account or Luckin.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
const { createAdapter } = await import(process.env.OAUTH_BROWSER_SERVER_MODULE || '../server.mjs');

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch {
  if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw new Error('This optional regression needs Playwright and Chromium in the engineering environment.');
  playwright = createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/package.json')('playwright');
}
const expectBlocked = process.argv.includes('--expect-blocked');
const owner = randomBytes(40).toString('base64url');
let handler, serverPostStatus = null, browserCallbackOrigin;
const server = http.createServer((req, res) => {
  // The browser fixture maps only the outbound callback origin to a local
  // receiver. The application's registered redirect URI and PKCE exchange
  // remain the real ChatGPT URI. This avoids external network/account access.
  const writeHead = res.writeHead.bind(res);
  res.writeHead = (status, headers) => {
    headers = { ...headers };
    if (headers['Content-Security-Policy']) headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace('https://chatgpt.com', browserCallbackOrigin);
    if (headers.Location) {
      const target = new URL(headers.Location);
      assert.equal(target.origin, 'https://chatgpt.com');
      headers.Location = browserCallbackOrigin + target.pathname + target.search;
    }
    return writeHead(status, headers);
  };
  res.on('finish', () => { if (req.method === 'POST' && req.url === '/oauth/authorize') serverPostStatus = res.statusCode; });
  handler(req, res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
handler = createAdapter({ NODE_ENV: 'test', PUBLIC_BASE_URL: base,
  ADAPTER_SIGNING_KEY: randomBytes(40).toString('base64url'), OWNER_LOGIN_SECRET: owner,
  LUCKIN_TOKEN: 'mock-only-no-real-provider-credential',
}).handle;
let callbackUrl = null;
const callbackServer = http.createServer((req, res) => {
  callbackUrl = new URL(req.url, 'https://chatgpt.com');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<h1>Local mock ChatGPT callback received</h1>');
});
await new Promise(resolve => callbackServer.listen(0, '127.0.0.1', resolve));
browserCallbackOrigin = `http://127.0.0.1:${callbackServer.address().port}`;
const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
try {
  for (const blockCookies of expectBlocked ? [false] : [false, true]) {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const registration = await fetch(base + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'none' }) });
    assert.equal(registration.status, 201);
    const { client_id } = await registration.json();
    const params = new URLSearchParams({ client_id, redirect_uri: callback, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, resource: base + '/mcp', scope: 'luckin:read', state: 'mock-browser-state' });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    callbackUrl = null;
    serverPostStatus = null;
    let cspBlocks = 0, postStatus = null;
    const diagnostics = [];
    page.on('console', message => {
      if (message.text().includes('form-action')) cspBlocks++;
      if (message.type() === 'error') diagnostics.push(message.text().replace(/\?.*/g, '?[omitted]').slice(0, 180));
    });
    page.on('response', response => {
      if (response.request().method() === 'POST' && response.url() === base + '/oauth/authorize') postStatus = response.status();
    });
    await page.goto(base + '/oauth/authorize?' + params);
    if (blockCookies) await context.clearCookies();
    await page.locator('[name="owner_secret"]').fill(owner);
    await page.locator('button[type="submit"]').click({ noWaitAfter: true });
    try { await page.waitForURL(browserCallbackOrigin + '/**', { timeout: 4000 }); }
    catch (e) { diagnostics.push(e.message.replace(/\?.*/g, '?[omitted]').slice(0, 250)); }
    if (expectBlocked) {
      await page.locator('body').innerText();
      assert.equal(callbackUrl, null);
      assert.ok(cspBlocks > 0, 'Expected Chromium to reproduce the callback-blocking CSP bug.');
      assert.equal(serverPostStatus, 303);
      console.log(JSON.stringify({ browser: 'Chromium', reproduced: 'CSP blocks OAuth callback after successful form POST', pass: true }));
    } else {
      if (!callbackUrl) console.log(JSON.stringify({ diagnostics, cspBlocks, postStatus, finalPage: page.url().split('?')[0], pageText: (await page.locator('body').innerText()).slice(0, 200) }));
      assert.ok(callbackUrl, 'OAuth callback must be reached in a real browser.');
      assert.equal(cspBlocks, 0);
      assert.equal(callbackUrl.origin, 'https://chatgpt.com');
      assert.equal(callbackUrl.pathname, '/connector_platform_oauth_redirect');
      assert.equal(callbackUrl.searchParams.get('state'), 'mock-browser-state');
      assert.equal(callbackUrl.searchParams.get('iss'), base);
      const exchange = await fetch(base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id, redirect_uri: callback, resource: base + '/mcp', code_verifier: verifier, code: callbackUrl.searchParams.get('code') }) });
      assert.equal(exchange.status, 200);
      const result = await exchange.json();
      assert.equal(result.scope, 'luckin:read');
      assert.ok(result.access_token);
      console.log(JSON.stringify({ browser: 'Chromium', cookiesBlocked: blockCookies, callbackReached: true, codeExchanged: true, pass: true }));
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  callbackServer.closeAllConnections();
  await new Promise(resolve => callbackServer.close(resolve));
}
