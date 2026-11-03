import { accountEventSchema, messageSchema, type AccountEvent, type Message } from "./chat-types";

export function createLiveEventConsumer(callbacks: {
  onMessage: (message: Message) => void | Promise<void>;
  onAccountEvent: (event: AccountEvent) => void | Promise<void>;
}) {
  return {
    async messageCreated(input: unknown) {
      const parsed = messageSchema.safeParse(input);
      if (!parsed.success) return false;
      await callbacks.onMessage(parsed.data);
      return true;
    },
    async accountEvent(input: unknown) {
      const parsed = accountEventSchema.safeParse(input);
      if (!parsed.success) return false;
      await callbacks.onAccountEvent(parsed.data);
      return true;
    },
  };
}
