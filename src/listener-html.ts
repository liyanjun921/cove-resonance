const FALLBACK_POLL_MS = 60_000;

export function buildListenerHtml(enableGeneralTest = false): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Cove Bridge</title>
<style>
  :root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}
  *{box-sizing:border-box}
  body{margin:0;padding:12px;background:transparent;color:CanvasText}
  .card{padding:14px;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:14px;background:color-mix(in srgb,Canvas 92%,transparent)}
  .title{font-weight:650}.status{margin-top:9px;font-size:12px;opacity:.72}
  button{margin-top:12px;padding:8px 12px;border-radius:10px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);background:Canvas;color:CanvasText;font:inherit;cursor:pointer}
  button:disabled{opacity:.55;cursor:default}
</style>
</head>
<body>
<main class="card">
  <div class="title">Cove Bridge</div>
  <div id="status" class="status">已挂载，尚未监听。</div>
  <button id="toggle" type="button" disabled>正在连接…</button>
  ${enableGeneralTest ? '<section aria-label="电影共看"><div class="title">同帧电影共看 v2 · 前台实验</div><p class="status">保持影院与本聊天打开。每五分钟请求当前聊天读取同帧；暂停或结束观影时请点停止。平台可能要求确认，锁屏后不能保证运行。</p><button id="cinema-start" type="button" disabled>开始电影共看（5分钟）</button><button id="cinema-test" type="button" disabled>测试一次续看</button><button id="cinema-stop" type="button" disabled>停止电影共看</button><div id="cinema-status" class="status" role="status">未开始 · 05:00</div></section>' : ''}
  ${enableGeneralTest ? '<div id="host-error" class="status" role="alert"></div>' : ''}
  ${enableGeneralTest ? '<button id="general-test-send" type="button" disabled>发送通用测试消息</button><button id="general-test-check" type="button" disabled>检查测试回复</button><div id="general-test-result" class="status" aria-live="polite"></div>' : ''}
</main>
<script>
(() => {
  const FALLBACK_POLL_MS = ${FALLBACK_POLL_MS};
  const generalTestEnabled = ${enableGeneralTest ? "true" : "false"};
  let currentGeneralTestId = '';
  const pending = new Map();
  let rpcId = 0;
  let timer = 0;
  let listening = false;
  let inFlight = false;
  let bridgeReady = false;
  let streamAbort = null;
  let streamGeneration = 0;
  let sseConnected = false;
  const DISPATCHED_STORAGE_KEY = 'cove-bridge-dispatched-v1';
  const PENDING_ACK_STORAGE_KEY = 'cove-bridge-pending-acks-v1';
  const PENDING_DISMISS_STORAGE_KEY = 'cove-bridge-pending-dismissals-v1';
  const MAX_RECENT_DISPATCHED = 128;
  const recentlyDispatched = new Set();
  const pendingAcks = new Set();
  const pendingDismissals = new Set();

  const statusEl = document.getElementById('status');
  const toggleEl = document.getElementById('toggle');
  const setStatus = (text) => { statusEl.textContent = text; };

  function readStoredIds(key) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  function writeStoredIds(key, ids) {
    try {
      localStorage.setItem(key, JSON.stringify(ids));
    } catch {}
  }

  for (const id of readStoredIds(DISPATCHED_STORAGE_KEY)) recentlyDispatched.add(id);
  for (const id of readStoredIds(PENDING_ACK_STORAGE_KEY)) pendingAcks.add(id);
  for (const id of readStoredIds(PENDING_DISMISS_STORAGE_KEY)) pendingDismissals.add(id);

  function rememberDispatched(eventId) {
    recentlyDispatched.delete(eventId);
    recentlyDispatched.add(eventId);
    while (recentlyDispatched.size > MAX_RECENT_DISPATCHED) {
      const oldest = recentlyDispatched.values().next().value;
      if (!oldest) break;
      recentlyDispatched.delete(oldest);
    }
    writeStoredIds(DISPATCHED_STORAGE_KEY, [...recentlyDispatched]);
  }

  function rememberPendingAck(eventId) {
    pendingAcks.add(eventId);
    writeStoredIds(PENDING_ACK_STORAGE_KEY, [...pendingAcks]);
  }

  function forgetPendingAck(eventId) {
    pendingAcks.delete(eventId);
    writeStoredIds(PENDING_ACK_STORAGE_KEY, [...pendingAcks]);
  }

  function rememberPendingDismissal(eventId) {
    pendingDismissals.add(eventId);
    writeStoredIds(PENDING_DISMISS_STORAGE_KEY, [...pendingDismissals]);
  }

  function forgetPendingDismissal(eventId) {
    pendingDismissals.delete(eventId);
    writeStoredIds(PENDING_DISMISS_STORAGE_KEY, [...pendingDismissals]);
  }

  async function flushPendingDismissals() {
    for (const eventId of [...pendingDismissals]) {
      try {
        await callTool('cove_bridge_dismissed', { eventId });
        forgetPendingDismissal(eventId);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (message.includes('Unknown event')) {
          forgetPendingDismissal(eventId);
          continue;
        }
        return false;
      }
    }
    return true;
  }

  async function flushPendingAcks() {
    for (const eventId of [...pendingAcks]) {
      try {
        await callTool('cove_bridge_delivered', { eventId });
        forgetPendingAck(eventId);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (message.includes('Unknown event')) {
          forgetPendingAck(eventId);
          continue;
        }
        return false;
      }
    }
    return true;
  }

  async function flushPendingTerminals() {
    if (!await flushPendingDismissals()) return false;
    return await flushPendingAcks();
  }

  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  }

  function request(method, params) {
    const id = ++rpcId;
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, 18000);
    });
  }

  function requestHumanDecision(method, params) {
    const id = ++rpcId;
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.setTimeout(() => {
        if (!pending.has(id)) return;
        setStatus('等待你确认发送或取消；不会重复投递。');
      }, 18000);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id === undefined) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(Object.assign(
      new Error(message.error.message || 'Host request failed'),
      { code: message.error.code }
    ));
    else entry.resolve(message.result);
  }, { passive: true });

  async function initialize() {
    await request('ui/initialize', {
      appInfo: { name: 'cove-bridge-widget', version: '0.1.0' },
      appCapabilities: {},
      protocolVersion: '2026-01-26'
    });
    notify('ui/notifications/initialized', {});
    bridgeReady = true;
    toggleEl.disabled = false;
    toggleEl.textContent = '开始监听';
    setStatus('已挂载，尚未监听。');
    if (generalTestEnabled) {
      document.getElementById('general-test-send').disabled = false;
      document.getElementById('cinema-start').disabled = false;
      document.getElementById('cinema-test').disabled = false;
    }
  }

  async function callTool(name, args) {
    if (!bridgeReady) throw new Error('Bridge is not initialized');
    const response = await request('tools/call', { name, arguments: args || {} });
    if (generalTestEnabled && response && response.isError) {
      throw new Error((response.content || []).filter((item) => item.type === 'text')
        .map((item) => item.text).join(' / ') || 'Bridge tool failed');
    }
    return response;
  }

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function setIdleStatus() {
    if (!listening) return;
    setStatus(sseConnected
      ? 'SSE 实时监听中，暂无新事件。'
      : '监听中（SSE 重连中，60 秒轮询兜底）。');
  }

  async function openWakeStream(generation) {
    let retryMs = 1000;

    while (listening && generation === streamGeneration) {
      try {
        const sessionResult = await callTool('cove_bridge_listener_session', {});
        const session = sessionResult && sessionResult.structuredContent;
        if (!session || !session.token || !session.streamUrl) {
          throw new Error('Bridge did not return a wake-stream session');
        }

        const streamUrl = new URL(String(session.streamUrl));
        streamUrl.searchParams.set('session', String(session.token));

        await new Promise((resolve, reject) => {
          const source = new EventSource(streamUrl.toString());
          streamAbort = { abort: () => source.close() };

          const fail = () => {
            source.close();
            reject(new Error('EventSource disconnected'));
          };

          source.onopen = () => {
            sseConnected = true;
            retryMs = 1000;
            setStatus('SSE 实时监听中。');
          };

          source.addEventListener('wake', () => {
            void syncOnce();
          });

          source.addEventListener('session-expired', () => {
            source.close();
            resolve();
          });

          source.onerror = fail;
        });
      } catch (error) {
        if (!listening || generation !== streamGeneration) return;
        const message = error && error.message ? error.message : String(error);
        setStatus('SSE 暂时断开：' + message + '；60 秒轮询兜底，正在重连…');
      } finally {
        if (generation === streamGeneration) {
          sseConnected = false;
          streamAbort = null;
        }
      }

      if (!listening || generation !== streamGeneration) return;
      await sleep(retryMs);
      retryMs = Math.min(15_000, retryMs * 2);
    }
  }

  async function dispatch(event) {
    await request('ui/update-model-context', {
      content: [{
        type: 'text',
        text: String(event.modelContext || ''),
        annotations: { audience: ['assistant'], priority: 1 }
      }],
      structuredContent: {
        bridgeEvent: {
          eventId: String(event.id),
          correlationId: String(event.correlationId || event.id),
          kind: String(event.kind || ''),
          source: String(event.source || ''),
          stream: String(event.stream || ''),
          stateKey: String(event.stateKey || ''),
          replyRoute: String(event.replyRoute || ''),
          replyPolicy: String(event.replyPolicy || ''),
          createdAt: String(event.createdAt || '')
        }
      }
    });

    // ui/message is now a human-confirmed Host operation. Once handed off,
    // never release the event merely because the user takes longer than an
    // ordinary RPC timeout to decide.
    setStatus('已交给 ChatGPT，等待你确认发送或取消…');
    try {
      await requestHumanDecision('ui/message', {
        role: 'user',
        content: [{ type: 'text', text: String(event.visibleText || '') }]
      });
      if (generalTestEnabled) document.getElementById('host-error').textContent = '';
      return { outcome: 'sent' };
    } catch (error) {
      if (generalTestEnabled) {
        const code = typeof error.code === 'number' ? ' (' + error.code + ')' : '';
        document.getElementById('host-error').textContent =
          '向聊天发送消息未成功' + code + '：' + (error.message || String(error))
          + '。本条事件已终止，不会自动重发；这不代表已经回复。';
      }
      return { outcome: 'dismissed', error };
    }
  }

  async function syncOnce() {
    if (!listening || inFlight) return;
    inFlight = true;
    let shouldContinue = false;
    try {
      const terminalsFlushed = await flushPendingTerminals();
      if (!terminalsFlushed) {
        setStatus('事件终态正在重试确认；不会重复显示。');
        return;
      }

      const result = await callTool('cove_bridge_sync', {});
      const event = result && result._meta && result._meta.event;
      if (!event) {
        const state = result && result.structuredContent;
        if (state && state.awaitingReply) {
          setStatus('等待当前消息完成回传…');
        } else {
          setIdleStatus();
        }
        return;
      }

      const eventId = String(event.id);
      if (recentlyDispatched.has(eventId)) {
        rememberPendingAck(eventId);
        const acked = await flushPendingAcks();
        if (!acked) {
          setStatus('重复事件已拦截，正在重试送达确认。');
          return;
        }
        shouldContinue = true;
        setStatus('重复投递已拦截。');
        return;
      }

      setStatus('正在投递事件…');
      let dispatchResult;
      try {
        dispatchResult = await dispatch(event);
      } catch (error) {
        // Only failures before ui/message handoff are safe to retry.
        await callTool('cove_bridge_release', { eventId }).catch(() => {});
        throw error;
      }

      // ui/message has been handed to the Host. Persist this before terminal
      // acknowledgement so a widget reload cannot show the same prompt again.
      rememberDispatched(eventId);

      if (dispatchResult && dispatchResult.outcome === 'dismissed') {
        rememberPendingDismissal(eventId);
        const dismissed = await flushPendingTerminals();
        if (!dismissed) {
          setStatus(generalTestEnabled
            ? '消息未发送；正在确认事件终态，不会重复显示。'
            : '本次提示已取消；正在重试取消确认，不会重复显示。');
          return;
        }
        shouldContinue = true;
        setStatus(generalTestEnabled ? '消息未发送，事件已终止。' : '本次提示已取消，不会重复显示。');
        return;
      }

      rememberPendingAck(eventId);
      const acked = await flushPendingTerminals();
      if (!acked) {
        setStatus('事件已显示，正在重试送达确认；不会重复显示。');
        return;
      }

      shouldContinue = true;
      setStatus('事件已送达。');
    } catch (error) {
      setStatus('监听错误：' + (error && error.message ? error.message : String(error)));
    } finally {
      inFlight = false;
      if (listening && shouldContinue) {
        window.setTimeout(() => void syncOnce(), 0);
      }
    }
  }

  function scheduleFallback() {
    window.clearInterval(timer);
    if (!listening) return;
    timer = window.setInterval(() => void syncOnce(), FALLBACK_POLL_MS);
  }

  function startListening() {
    listening = true;
    toggleEl.textContent = '停止监听';
    setStatus('正在建立 SSE 实时监听…');
    scheduleFallback();
    streamGeneration += 1;
    const generation = streamGeneration;
    void openWakeStream(generation);
    void syncOnce();
  }

  function stopListening() {
    listening = false;
    toggleEl.textContent = '开始监听';
    window.clearInterval(timer);
    streamGeneration += 1;
    sseConnected = false;
    if (streamAbort) streamAbort.abort();
    streamAbort = null;
    setStatus('已暂停。');
  }

  toggleEl.addEventListener('click', () => {
    if (listening) stopListening();
    else startListening();
  });

  // This is a fixed, local scheduling hint, not an ingress event or a data
  // transport. No movie content, ChatGPT replies, or private credentials are
  // sent to the public test backend. The current model uses the private cinema
  // connector after the host accepts the hint. Existing queue/ACK paths stay
  // unchanged and cannot run concurrently with this card's cinema timer.
  if (generalTestEnabled) {
    const start = document.getElementById('cinema-start');
    const test = document.getElementById('cinema-test');
    const stop = document.getElementById('cinema-stop');
    const state = document.getElementById('cinema-status');
    const INTERVAL = 300000;
    let active = false, pendingSend = false, nextAt = 0, clock = 0, submitted = 0;
    const prompt = '【电影共看定时请求；不是林言手动发言】观众在旧监听卡片主动开启了电影共看。沿用当前聊天的身份与上下文，先用私人同帧插件调用 cinema_status；仅在房间在线、共享开启且正在播放时，调用 cinema_read_screen，带上已有 sinceMessageId 和 sinceTimeMs，保留 nextMessageId 与 nextMediaMs。依据实际抽帧和已播放字幕自然回复，并用 cinema_post_message 写回影院。暂停、结束或离线时不编造画面、不发观影评论。不要重开监听卡片。此信号没有外部回复路由，不调用 cove_bridge_reply，不把聊天内容或电影内容发送到公共消息桥。';
    function controls() {
      start.disabled = active || pendingSend || !bridgeReady;
      test.disabled = active || pendingSend || !bridgeReady;
      stop.disabled = !active && !pendingSend;
      toggleEl.disabled = active || pendingSend || !bridgeReady;
      document.getElementById('general-test-send').disabled = active || pendingSend || !bridgeReady;
    }
    function halt(message) {
      active = false;
      window.clearInterval(clock);
      clock = 0;
      controls();
      state.textContent = message || '电影共看已停止';
    }
    async function sendOnce(single) {
      if (pendingSend || !bridgeReady) return;
      pendingSend = true;
      controls();
      state.textContent = '正在请求当前聊天续看；等待平台确认，不会重复提交。';
      try {
        // Like the working old card, keep this pending until the host actually
        // resolves the human decision. A timeout must never cause redispatch.
        const answer = await requestHumanDecision('ui/message', {
          role: 'user', content: [{ type: 'text', text: prompt }]
        });
        const outcome = answer && (answer.outcome || answer.status);
        if (answer && (answer.isError || ['dismissed', 'cancelled', 'canceled', 'rejected'].includes(outcome))) {
          throw new Error('平台取消了本次续看请求');
        }
        submitted++;
        if (single || !active) halt('请求已提交 ' + submitted + ' 次；请核对聊天是否实际回复。单次测试不会开启循环。');
        else {
          nextAt = Date.now() + INTERVAL;
          state.textContent = '请求已提交 ' + submitted + ' 次（不等于已回复）；下一次 05:00。';
        }
      } catch (error) {
        halt('续看未发送，已停止且不重试：' + (error.message || String(error)));
      } finally {
        pendingSend = false;
        controls();
      }
    }
    function tick() {
      if (!active || pendingSend) return;
      if (document.hidden) { nextAt = Date.now() + INTERVAL; return; }
      const left = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
      state.textContent = '电影共看前台计时 ' + String(Math.floor(left / 60)).padStart(2, '0')
        + ':' + String(left % 60).padStart(2, '0') + ' · 已提交 ' + submitted + ' 次；实际回复请以聊天为准。';
      if (!left) void sendOnce(false);
    }
    function prepare() {
      if (!bridgeReady || pendingSend) return false;
      if (inFlight) { state.textContent = '旧事件仍在处理，请先完成或取消那次发送，再开启电影共看。'; return false; }
      stopListening();
      return true;
    }
    start.addEventListener('click', () => {
      if (!prepare()) return;
      active = true;
      nextAt = Date.now() + INTERVAL;
      controls();
      tick();
      clock = window.setInterval(tick, 1000);
    });
    test.addEventListener('click', () => {
      if (prepare()) void sendOnce(true);
    });
    stop.addEventListener('click', () => halt(pendingSend
      ? '后续计时已停止；已交给平台的本次确认仍需你在聊天中处理。' : '电影共看已停止'));
    document.addEventListener?.('visibilitychange', () => {
      if (active) {
        nextAt = Date.now() + INTERVAL;
        if (document.hidden) state.textContent = '卡片在后台，已暂停；回来后重新计时五分钟。';
      }
    });
    window.addEventListener('pagehide', () => halt('卡片已离开，电影共看已停止'));
  }

  if (generalTestEnabled) {
    const sendButton = document.getElementById('general-test-send');
    const checkButton = document.getElementById('general-test-check');
    const result = document.getElementById('general-test-result');
    sendButton.addEventListener('click', async () => {
      if (!bridgeReady) return;
      if (!listening) {
        result.textContent = '请先点击「开始监听」，再发送测试。';
        return;
      }
      sendButton.disabled = true;
      try {
        const response = await callTool('cove_bridge_test_event', {});
        const data = response && response.structuredContent;
        if (!data || !data.queued || !data.eventId) throw new Error('Test event not accepted');
        currentGeneralTestId = String(data.eventId);
        checkButton.disabled = false;
        result.textContent = '已创建非网易云测试事件。等 ChatGPT 出现确认弹窗时点击允许，然后检查测试回复。';
        void syncOnce();
      } catch (error) {
        result.textContent = '测试事件失败：' + (error.message || String(error));
      } finally {
        sendButton.disabled = false;
      }
    });
    checkButton.addEventListener('click', async () => {
      if (!currentGeneralTestId) return;
      checkButton.disabled = true;
      try {
        const response = await callTool('cove_bridge_test_status', { eventId: currentGeneralTestId });
        const data = response && response.structuredContent;
        if (!data) throw new Error('No status returned');
        result.textContent = data.completed
          ? '通用收件箱已收到 AI 回复：' + (Array.isArray(data.messages) ? data.messages.join(' / ') : '')
          : data.endedWithoutReply
            ? '这条测试已终止，没有回复写回收件箱。若上方显示发送错误，请以该错误为准。'
            : '尚未收到完整回复。请确认 ChatGPT 已处理测试消息并调用通用回复工具。';
      } catch (error) {
        result.textContent = '检查失败：' + (error.message || String(error));
      } finally {
        checkButton.disabled = false;
      }
    });
  }

  initialize().catch((error) => {
    toggleEl.disabled = true;
    toggleEl.textContent = '连接失败';
    setStatus('组件连接失败：' + (error && error.message ? error.message : String(error)));
  });
})();
</script>
</body>
</html>`;
}
