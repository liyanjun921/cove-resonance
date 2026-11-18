/**
 * Per-event generic reply inbox. This is a server-to-server MVP, not a
 * browser-facing API: credentials stay on the trusted gateway.
 *
 * The queue in Cove v2 is in-memory; these replies likewise disappear on
 * restart. Persist both before relying on unattended production delivery.
 */
export type ExternalReply = {
  eventId: string;
  messages: string[];
  completed: boolean;
  updatedAt: string;
};

export class ExternalReplyInbox {
  private readonly records = new Map<string, ExternalReply>();

  append(eventId: string, message: string): void {
    const prior = this.records.get(eventId);
    const messages = [...(prior?.messages ?? []), message];
    this.records.set(eventId, {
      eventId,
      messages,
      completed: false,
      updatedAt: new Date().toISOString(),
    });
  }

  complete(eventId: string): void {
    const record = this.records.get(eventId);
    if (!record) return;
    this.records.set(eventId, {
      ...record,
      completed: true,
      updatedAt: new Date().toISOString(),
    });
  }

  read(eventId: string): ExternalReply | null {
    const record = this.records.get(eventId);
    if (!record) return null;
    return { ...record, messages: [...record.messages] };
  }
}

export const externalReplyInbox = new ExternalReplyInbox();
