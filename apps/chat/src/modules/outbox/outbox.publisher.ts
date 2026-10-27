import { setTimeout as delay } from "node:timers/promises";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db.js";
import { accountEvents, messages, outboxEvents } from "../../db/schema.js";

export const OUTBOX_CHANNEL = "tether:outbox";

const messageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  sequence: z.number().int().positive(),
  senderId: z.string().min(1),
  clientMessageId: z.uuid(),
  content: z.string(),
  createdAt: z.iso.datetime(),
});

const accountEventSchema = z.object({
  id: z.uuid(),
  userId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: z.literal("message.created"),
  conversationId: z.uuid(),
  messageId: z.uuid(),
  payload: z.unknown(),
  createdAt: z.iso.datetime(),
});

export const outboxEnvelopeSchema = z.object({
  version: z.literal(1),
  outboxId: z.uuid(),
  message: messageSchema,
  accountEvents: z.array(accountEventSchema).min(1),
});

export type OutboxEnvelope = z.infer<typeof outboxEnvelopeSchema>;
type Database = typeof db;
type Publish = (channel: string, payload: string) => Promise<number>;

export async function publishOutboxBatch(
  publish: Publish,
  database: Database = db,
  batchSize = 50,
) {
  return database.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.publishedAt))
      .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });

    for (const outbox of pending) {
      const [message] = await tx
        .select()
        .from(messages)
        .where(eq(messages.id, outbox.messageId))
        .limit(1);
      const events = await tx
        .select()
        .from(accountEvents)
        .where(eq(accountEvents.messageId, outbox.messageId))
        .orderBy(asc(accountEvents.userId));
      if (!message || events.length === 0) throw new Error("incomplete outbox event");

      const envelope = outboxEnvelopeSchema.parse({
        version: 1,
        outboxId: outbox.id,
        message: { ...message, createdAt: message.createdAt.toISOString() },
        accountEvents: events.map((event) => ({
          ...event,
          createdAt: event.createdAt.toISOString(),
        })),
      });
      if ((await publish(OUTBOX_CHANNEL, JSON.stringify(envelope))) < 1) {
        throw new Error("outbox has no subscribers");
      }

      await tx
        .update(outboxEvents)
        .set({ publishedAt: new Date() })
        .where(and(eq(outboxEvents.id, outbox.id), isNull(outboxEvents.publishedAt)));
    }

    return pending.length;
  });
}

export async function runOutboxPublisher(
  processBatch: () => Promise<number>,
  signal: AbortSignal,
  options: {
    idleDelayMs?: number;
    errorDelayMs?: number;
    onError?: (error: unknown) => void;
  } = {},
) {
  const { idleDelayMs = 500, errorDelayMs = 1_000, onError } = options;

  while (!signal.aborted) {
    let waitMs = 0;
    try {
      if ((await processBatch()) === 0) waitMs = idleDelayMs;
    } catch (error) {
      onError?.(error);
      waitMs = errorDelayMs;
    }

    if (waitMs > 0 && !signal.aborted) {
      try {
        await delay(waitMs, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }
}

export function startOutboxPublisher({
  publish,
  signal,
  database = db,
  onError,
}: {
  publish: Publish;
  signal: AbortSignal;
  database?: Database;
  onError?: (error: unknown) => void;
}) {
  return runOutboxPublisher(() => publishOutboxBatch(publish, database), signal, { onError });
}
