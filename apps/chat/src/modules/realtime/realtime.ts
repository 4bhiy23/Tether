import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import type { Server } from "socket.io";
import { OUTBOX_CHANNEL, outboxEnvelopeSchema } from "../outbox/outbox.publisher.js";

export function dispatchOutboxEnvelope(io: Server, payload: string) {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return false;
  }

  const envelope = outboxEnvelopeSchema.safeParse(value);
  if (!envelope.success) return false;

  io.local
    .to(`conversation:${envelope.data.message.conversationId}`)
    .emit("message.created", envelope.data.message);
  for (const event of envelope.data.accountEvents) {
    io.local.to(`user:${event.userId}`).emit("account.event", event);
  }
  return true;
}

export function createRealtime(
  io: Server,
  redisUrl: string,
  onError: (source: string) => void = (source) => console.error(`${source} error`),
) {
  const publisher = createClient({ url: redisUrl });
  const adapterSubscriber = publisher.duplicate();
  const outboxSubscriber = publisher.duplicate();

  publisher.on("error", () => onError("Redis publisher"));
  adapterSubscriber.on("error", () => onError("Redis adapter subscriber"));
  outboxSubscriber.on("error", () => onError("Redis outbox subscriber"));

  return {
    async start() {
      await Promise.all([
        publisher.connect(),
        adapterSubscriber.connect(),
        outboxSubscriber.connect(),
      ]);
      io.adapter(createAdapter(publisher, adapterSubscriber));
      await outboxSubscriber.subscribe(OUTBOX_CHANNEL, (payload) => {
        if (!dispatchOutboxEnvelope(io, payload)) onError("Invalid outbox envelope");
      });
    },

    publish(channel: string, payload: string) {
      return publisher.publish(channel, payload);
    },

    ping() {
      return publisher.ping();
    },

    async close() {
      await Promise.allSettled([
        outboxSubscriber.quit(),
        adapterSubscriber.quit(),
        publisher.quit(),
      ]);
    },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;
