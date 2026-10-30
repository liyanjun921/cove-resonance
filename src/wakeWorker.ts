import { randomUUID } from "node:crypto";
import { buildBridgeEvent } from "./bridge/events.js";
import { listenerWakeHub } from "./listenerWake.js";
import type { InMemoryEventQueue } from "./queue.js";

const FORTY_FIVE_MINUTES = 45 * 60_000;
const ONE_HOUR = 60 * 60_000;

/**
 * Optional wake event producer. It does not drive the MCP App: only the
 * ChatGPT-hosted Listener can forward a queued event into the conversation.
 *
 * Disabled by default. Caller must report user activity from its trusted
 * gateway; ChatGPT-window messages are not observable by this worker.
 */
export class WakeWorker {
  private lastActivityAt: number;
  private lastWakeAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly queue: InMemoryEventQueue,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.lastActivityAt = now();
  }

  noteUserActivity(at = this.now()): void {
    this.lastActivityAt = at;
  }

  evaluate(at = this.now()): { eligible: boolean; reason: string } {
    const hour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Singapore", hour: "2-digit", hour12: false,
    }).format(new Date(at))) % 24;
    if (hour >= 1 && hour < 9) return { eligible: false, reason: "quiet_hours" };
    if (at - this.lastActivityAt < FORTY_FIVE_MINUTES)
      return { eligible: false, reason: "recent_user_activity" };
    if (this.lastWakeAt !== null && at - this.lastWakeAt < ONE_HOUR)
      return { eligible: false, reason: "minimum_interval" };
    return { eligible: true, reason: "ready" };
  }

  tick(at = this.now()): boolean {
    if (!this.evaluate(at).eligible) return false;
    const eventId = "wake:" + randomUUID();
    const event = buildBridgeEvent(
      eventId, "wake.heartbeat",
      "Optional autonomous wake: reconnect continuity, decide whether a gentle check-in is useful. Respect the user's latest messages and quiet hours.",
      new Date(at).toISOString(),
    );
    const created = this.queue.enqueue(event);
    if (created) {
      this.lastWakeAt = at;
      listenerWakeHub.wake("wake.heartbeat");
    }
    return created;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
