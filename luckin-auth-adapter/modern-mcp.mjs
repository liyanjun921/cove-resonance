// MCP 2026-07-28 at the client boundary; Luckin keeps its legacy transport.
// Per-request capabilities and native MRTR responses never reach the merchant.
export function createModernMcp({ upstream, discoveredTools, ensureDiscovered, orderGuard, json, seal, unseal, hash, random, now, boot, Failure, safeTools, orderScope, instructions }) {
  const VERSION = '2026-07-28';
  const transportSessions = new Map();
  const confirmations = new Map();
  const fail = (ok, status, code, text) => { if (!ok) throw new Failure(status, code, text); };
  const scopeGranted = p => p.scope.split(' ').includes(orderScope);
  const accepts = (m, req) => m?.method === 'server/discover' || req.headers['mcp-protocol-version'] === VERSION || m?.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === VERSION;
  async function transport(principal) {
    let entry = transportSessions.get(principal.jti);
    if (!entry || entry.exp <= now()) {
      for (const [id, old] of transportSessions) if (old.exp <= now()) transportSessions.delete(id);
      fail(transportSessions.size < 100, 429, 'session_limit', '暂时无法创建新的瑞幸连接。');
      entry = { exp: now() + 28800 };
      entry.promise = (async () => {
        const initialized = await upstream({ jsonrpc: '2.0', id: `init-${random()}`, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'xlc-luckin-protocol-adapter', version: '0.2.0' } } });
        fail(!initialized.message.error && typeof initialized.message.result?.protocolVersion === 'string', 502, 'upstream_initialize_failed', '瑞幸初始化失败。');
        const session = { upstreamId: initialized.upstreamId, protocol: initialized.message.result.protocolVersion, tools: new Set() };
        await upstream({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
        return session;
      })();
      transportSessions.set(principal.jti, entry);
      entry.promise.catch(() => { if (transportSessions.get(principal.jti) === entry) transportSessions.delete(principal.jti); });
    }
    return entry.promise;
  }
  function formSupport(caps) {
    const form = !!caps.elicitation && (Object.hasOwn(caps.elicitation, 'form') || Object.keys(caps.elicitation).length === 0);
    return { form, extended: !!caps.extensions?.['openai/elicitation']?.form };
  }
  function orderInput(message, principal, session, caps) {
    const p = message.params;
    fail(scopeGranted(principal), 401, 'order_scope_required', '当前连接仅授权查询，请另行授权下单权限。');
    const support = formSupport(caps);
    fail(support.form, 409, 'confirmation_not_supported', '客户端未声明原生确认表单能力，本次不创建订单。');
    fail(p.arguments && Object.keys(p.arguments).length === 1 && typeof p.arguments.previewReceipt === 'string', 400, 'invalid_request', '创建订单只接受最新 previewReceipt。');
    return support;
  }
  async function create(message, principal, session, caps) {
    const p = message.params, support = orderInput(message, principal, session, caps);
    if (p.requestState !== undefined || p.inputResponses !== undefined) {
      let state;
      try { state = unseal(p.requestState, 'order_confirmation'); } catch { throw new Failure(409, 'invalid_confirmation', '订单确认状态已失效。'); }
      const flow = confirmations.get(state.nonce);
      fail(state.boot === boot && state.owner === principal.jti && state.receipt === hash(p.arguments.previewReceipt) && flow && flow.owner === principal.jti, 403, 'invalid_confirmation', '订单确认不属于当前登录、预览或服务。');
      const answer = p.inputResponses?.[state.nonce];
      fail(answer && ['accept', 'decline', 'cancel'].includes(answer.action), 400, 'invalid_confirmation', '缺少有效的原生确认结果。');
      confirmations.delete(state.nonce);
      clearTimeout(flow.timer);
      flow.answer(answer);
      return { ...(await flow.work), resultType: 'complete' };
    }
    fail(confirmations.size < 100, 429, 'confirmation_limit', '待确认订单过多，暂不接受新订单。');
    const nonce = random(), flow = { owner: principal.jti };
    let ready;
    const waiting = new Promise(resolve => { ready = resolve; });
    flow.work = orderGuard.create(p.arguments.previewReceipt, principal, session, summary => new Promise(answer => {
      flow.answer = answer;
      flow.timer = setTimeout(() => { confirmations.delete(nonce); answer({ action: 'cancel' }); }, 180000);
      flow.timer.unref();
      confirmations.set(nonce, flow);
      const requestedSchema = { type: 'object', properties: { confirmed: { type: 'boolean', title: '我确认创建上述真实订单，付款由我自行完成', default: false } }, required: ['confirmed'] };
      ready({ resultType: 'input_required', requestState: seal('order_confirmation', { nonce, boot, owner: principal.jti, receipt: hash(p.arguments.previewReceipt), exp: now() + 180 }),
        inputRequests: { [nonce]: { method: 'elicitation/create', params: {
          mode: 'form', message: summary,
          // Always include a complete standard schema, even with the extension.
          requestedSchema,
          ...support.extended ? { _meta: { 'openai/elicitation': { requestedSchema } } } : {},
        } } },
      });
    }));
    // The continuation is resumed only by protocol inputResponses, never by a
    // model-callable argument. Handle timeout/cancel rejection after response.
    flow.work.catch(() => {});
    return Promise.race([waiting, flow.work.then(result => ({ ...result, resultType: 'complete' }))]);
  }
  async function handle(message, req, res, principal) {
    const meta = message.params?._meta;
    const version = meta?.['io.modelcontextprotocol/protocolVersion'];
    if (version !== VERSION) return json(res, 400, { jsonrpc: '2.0', id: message.id, error: { code: -32022, message: 'Unsupported protocol version', data: { requested: version || req.headers['mcp-protocol-version'] || null, supported: [VERSION, '2025-03-26'] } } });
    fail(!req.headers['mcp-protocol-version'] || req.headers['mcp-protocol-version'] === version, 400, 'protocol_mismatch', 'MCP 协议版本不一致。');
    const caps = meta['io.modelcontextprotocol/clientCapabilities'];
    const client = meta['io.modelcontextprotocol/clientInfo'];
    fail(caps && typeof caps === 'object' && !Array.isArray(caps) && typeof client?.name === 'string' && typeof client?.version === 'string', 400, 'invalid_request', '缺少 MCP 客户端能力或身份信息。');
    let result;
    if (message.method === 'server/discover') result = { resultType: 'complete', supportedVersions: [VERSION], capabilities: { tools: {} }, instructions, ttlMs: 60000, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'xlc-luckin-auth-adapter', version: '0.2.0' } } };
    else {
      fail(['tools/list', 'tools/call', 'ping'].includes(message.method), 400, 'method_not_allowed', '此服务只提供瑞幸点单工具。');
      if (message.method === 'ping') result = { resultType: 'complete' };
      else {
        const name = message.params?.name;
        if (message.method === 'tools/call') {
          fail(safeTools.has(name) || name === 'createOrder', 403, 'write_disabled', '取消及未知工具未开放。');
          if (name === 'createOrder') orderInput(message, principal, null, caps);
        }
        const session = await transport(principal);
        if (message.method === 'tools/list') {
          const listing = await upstream({ jsonrpc: '2.0', id: `list-${random()}`, method: 'tools/list', params: {} }, session);
          result = { resultType: 'complete', tools: discoveredTools(listing.message, session) };
        } else {
          await ensureDiscovered(session);
          fail(session.tools.has(name), 400, 'tool_not_discovered', '该工具未出现在瑞幸实际返回的列表中。');
          if (name === 'createOrder') result = await create(message, principal, session, caps);
          else {
            const reply = await upstream({ jsonrpc: '2.0', id: `call-${random()}`, method: 'tools/call', params: { name, arguments: message.params.arguments } }, session);
            if (reply.message.error) return json(res, 200, { ...reply.message, id: message.id });
            result = { ...reply.message.result, resultType: 'complete' };
            if (name === 'previewOrder' && !result.isError) {
              try {
                result.content.push({ type: 'text', text: JSON.stringify({ adapterOrderPreview: { ...orderGuard.capture(result, message.params.arguments, principal), confirmationSupported: formSupport(caps).form, orderScopeGranted: scopeGranted(principal) } }) });
              } catch { /* Preserve actual preview even if no safe draft can be captured. */ }
            }
          }
        }
      }
    }
    return json(res, 200, { jsonrpc: '2.0', id: message.id, result });
  }
  return { accepts, handle };
}
