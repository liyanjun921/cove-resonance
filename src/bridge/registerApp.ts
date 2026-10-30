import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { buildBridgeEvent } from "./events.js";
import type { InMemoryEventQueue } from "../queue.js";
import { externalReplyInbox } from "../externalReplyInbox.js";
import { buildListenerHtml } from "../listener-html.js";
import { listenerWakeHub } from "../listenerWake.js";

export const RESOURCE_URI = "ui://widget/cove-bridge.html";
export const CINEMA_RESOURCE_URI = "ui://widget/xlc-general-cinema-v2.html";
const LEGACY_GENERIC_URI = "ui://widget/xlc-general-bridge.html";
let lastGenericTestAt = 0;
const PUBLIC_ORIGIN = process.env.BRIDGE_PUBLIC_ORIGIN?.trim()
  || "http://localhost:" + (process.env.PORT ?? "8787");

export function registerBridgeApp(server: McpServer, testQueue?: InMemoryEventQueue): void {
  const isGeneric = Boolean(testQueue);
  const resourceUri = isGeneric ? CINEMA_RESOURCE_URI : RESOURCE_URI;
  const templateMeta = { ui: { resourceUri }, "ui/resourceUri": resourceUri, "openai/outputTemplate": resourceUri };
  const html = buildListenerHtml(isGeneric);

  // Keep old conversation bindings readable, but new renders must point to
  // a fresh cache key. Resource metadata contains UI policy, not tool metadata.
  for (const uri of isGeneric ? [resourceUri, LEGACY_GENERIC_URI] : [resourceUri]) {
    registerAppResource(
      server,
      uri === LEGACY_GENERIC_URI ? "cove-bridge-legacy-widget" : "cove-bridge-widget",
      uri,
      {},
      async () => ({
        contents: [{
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: {
              domain: PUBLIC_ORIGIN,
              prefersBorder: false,
              csp: { connectDomains: [PUBLIC_ORIGIN], resourceDomains: [] },
            },
            "openai/widgetDescription": isGeneric
              ? "同帧电影共看 v2。默认未启动；请点击测试一次续看验证当前聊天。"
              : "A manually controlled listener for Cove Resonance events.",
          },
        }],
      }),
    );
  }

  registerAppTool(
    server,
    "open_cove_bridge",
    {
      title: "Open Cove Resonance",
      description: "Mount the Cove Resonance listener component in an idle state. Only use when the user explicitly asks to open it. Opening does not start listening; the user starts listening from the component.",
      inputSchema: {},
      outputSchema: { ready: z.boolean(), listening: z.boolean(), componentVersion: z.string().optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: templateMeta,
    },
    async () => ({
      structuredContent: { ready: true, listening: false, ...(isGeneric ? { componentVersion: "cinema-2" } : {}) },
      ...(isGeneric ? { _meta: templateMeta } : {}),
      content: [{ type: "text", text: isGeneric
        ? "已请求同帧电影共看 v2 卡片，尚未开始。界面必须出现“电影共看 v2”和“测试一次续看”按钮才算新版实际显示；工具返回不代表显示成功。只打开本卡片，不要再调用 cinema_open_listener 或 cinema_open_listener_basic。私人同帧插件仅用于 cinema_status、cinema_read_screen 与 cinema_post_message。"
        : "Cove Resonance mounted in an idle state. Listening has not started." }],
    }),
  );

  server.registerTool(
    "cove_bridge_listener_session",
    {
      title: "Cove Resonance listener session",
      description: "Create a short-lived, single-use authorization token for the Cove Resonance wake stream. App-only.",
      inputSchema: {},
      outputSchema: {
        token: z.string(),
        streamUrl: z.string(),
        expiresAt: z.string(),
        fallbackPollMs: z.number(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => {
      const session = listenerWakeHub.createSession();
      return {
        structuredContent: {
          token: session.token,
          streamUrl: PUBLIC_ORIGIN + "/listener/events",
          expiresAt: session.expiresAt,
          fallbackPollMs: 60_000,
        },
        content: [],
      };
    },
  );
  // This fixed-content self-test is intentionally limited to the isolated,
  // fictional testing profile. No user-supplied text or external secrets.
  if (testQueue) {
    const queue = testQueue;
    server.registerTool(
      "cove_bridge_test_event",
      {
        title: "Send non-NetEase bridge test",
        description: "App-only: enqueue one fixed non-sensitive generic message to test the Listener.",
        inputSchema: {},
        outputSchema: {
          queued: z.boolean(),
          eventId: z.string(),
          source: z.literal("test.general-bridge"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        _meta: { ui: { visibility: ["app"] } },
      },
      async () => {
        if (Date.now() - lastGenericTestAt < 15000) throw new Error("Please wait 15 seconds between tests.");
        const eventId = "test:" + randomUUID();
        const event = buildBridgeEvent(
          eventId, "test.general-bridge",
          "XLC General Message Bridge test: this message was generated by the Listener card, not NetEase. Please reply with one short confirmation through cove_bridge_reply.",
        );
        const queued = queue.enqueue(event);
        if (queued) {
          lastGenericTestAt = Date.now();
          listenerWakeHub.wake("test.general-bridge");
        }
        return {
          structuredContent: { queued, eventId, source: "test.general-bridge" as const },
          content: [],
        };
      },
    );

    server.registerTool(
      "cove_bridge_test_status",
      {
        title: "Check non-NetEase bridge test reply",
        description: "App-only: check completion of a single fixed test event.",
        inputSchema: { eventId: z.string().startsWith("test:").max(100) },
        outputSchema: {
          completed: z.boolean(),
          endedWithoutReply: z.boolean(),
          messages: z.array(z.string()),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ eventId }) => {
        const reply = externalReplyInbox.read(eventId);
        return { structuredContent: {
          completed: Boolean(reply?.completed),
          endedWithoutReply: testQueue!.hasEndedWithoutReply(eventId),
          messages: reply?.messages ?? [],
        }, content: [] };
      },
    );
  }

}
