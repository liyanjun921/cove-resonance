import { buildBridgeEvent } from "./bridge/events.js";
import type { InMemoryEventQueue } from "./queue.js";

export const LISTENER_WAKE_SOURCE = "wake.listener-test";
const MINUTE = 60_000;

type Options = {
  enabled: boolean;
  intervalMinutes?: number;
  firstDelaySeconds?: number;
};

/** Fixed public wake signals only; never stores conversation text or replies. */
export class ListenerWakeScheduler {
  private readonly intervalMs: number;
  private nextDueAt: number;
  private timer: NodeJS.Timeout | null = null;
  private lastEventId: string | null = null;
  private lastQueuedAt: string | null = null;
  private lastReason = "not_checked";

  constructor(
    private readonly queue: InMemoryEventQueue,
    private readonly options: Options,
    private readonly clientCount: () => number,
    private readonly wake: () => void,
    private readonly now: () => number = Date.now,
  ) {
    const interval = options.intervalMinutes ?? 15;
    const firstDelay = options.firstDelaySeconds ?? interval * 60;
    if (!Number.isInteger(interval) || interval < 15 || interval > 1440) {
      throw new Error("Listener wake interval must be 15–1440 whole minutes");
    }
    if (!Number.isInteger(firstDelay) || firstDelay < 60 || firstDelay > 86400) {
      throw new Error("Listener wake first delay must be 60–86400 whole seconds");
    }
    this.intervalMs = interval * MINUTE;
    this.nextDueAt = now() + firstDelay * 1000;
  }

  tick(at = this.now()): boolean {
    this.queue.pruneExpiredPendingStates(at);
    if (!this.options.enabled) return this.skip("disabled");
    const hour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false,
    }).format(new Date(at))) % 24;
    if (hour >= 1 && hour < 9) return this.skip("quiet_hours");
    if (at < this.nextDueAt) return this.skip("not_due");
    const clients = this.clientCount();
    if (clients !== 1) return this.skip(clients === 0 ? "listener_offline" : "multiple_listeners");
    const status = this.queue.status();
    if (status.pending || status.reserved || this.queue.getOutstandingRequiredReplyEvent()) {
      return this.skip("queue_busy");
    }

    // Stable within a time slot, including across backend restarts. The
    // existing widget dispatch journal suppresses a repeated slot ID.
    const id = "wake:listener:" + Math.floor(at / this.intervalMs);
    const event = buildBridgeEvent(
      id, LISTENER_WAKE_SOURCE,
      "【自主唤醒】到了一次自主评估时间。",
      new Date(at).toISOString(),
      [
        "This is an owner-authorized scheduled evaluation, not a message written by the human.",
        "Use the current official conversation's normal continuity and preferences to decide whether a brief check-in is useful or to remain silent.",
        "A wake is not a requirement to send a message. Respect recent interaction and the owner's contact-frequency preferences; do not invent activity timestamps.",
        "There is no external reply route: do not call cove_bridge_reply and do not send conversation text to this public test backend.",
        "This wake does not request music actions or changes to RIVERSE.",
      ].join("\n"),
    );
    event.expiresAt = new Date(at + 2 * MINUTE).toISOString();
    const queued = this.queue.enqueue(event);
    this.nextDueAt = at + this.intervalMs;
    if (!queued) return this.skip("duplicate_slot");
    this.lastEventId = id;
    this.lastQueuedAt = new Date(at).toISOString();
    this.lastReason = "queued";
    this.wake();
    return true;
  }

  status() {
    return {
      enabled: this.options.enabled,
      intervalMinutes: this.intervalMs / MINUTE,
      quietHours: "01:00–09:00 Asia/Shanghai",
      requiresSingleOnlineListener: true,
      nextEligibleAt: this.options.enabled ? new Date(this.nextDueAt).toISOString() : null,
      lastEventId: this.lastEventId,
      lastQueuedAt: this.lastQueuedAt,
      lastReason: this.lastReason,
      // Queueing never claims host acceptance or an actual model response.
      deliveryVerified: false,
    };
  }

  start(): void {
    if (!this.options.enabled || this.timer) return;
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private skip(reason: string): false {
    this.lastReason = reason;
    return false;
  }
}
