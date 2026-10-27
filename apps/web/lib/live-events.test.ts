import assert from "node:assert/strict";
import test from "node:test";
import { createLiveEventConsumer } from "./live-events.js";

type Message = { id: string; content: string };
type AccountEvent = { id: string; payload: Message };

function consumer() {
  const messages: Message[] = [];
  const accountEvents: AccountEvent[] = [];
  return {
    accountEvents,
    messages,
    live: createLiveEventConsumer<Message, AccountEvent>({
      onMessage: (message) => messages.push(message),
      onAccountEvent: (event) => accountEvents.push(event),
    }),
  };
}

test("delivers one message when room and account events overlap", () => {
  const { accountEvents, live, messages } = consumer();
  const message = { id: "message-1", content: "hello" };

  assert.equal(live.messageCreated(message), true);
  assert.equal(live.accountEvent({ id: "event-1", payload: message }), true);

  assert.deepEqual(messages, [message]);
  assert.deepEqual(accountEvents, [{ id: "event-1", payload: message }]);
});

test("ignores a repeated account event", () => {
  const { accountEvents, live, messages } = consumer();
  const event = {
    id: "event-1",
    payload: { id: "message-1", content: "hello" },
  };

  assert.equal(live.accountEvent(event), true);
  assert.equal(live.accountEvent(event), false);

  assert.deepEqual(messages, [event.payload]);
  assert.deepEqual(accountEvents, [event]);
});

test("evicts the oldest remembered IDs after 1,000 entries", () => {
  const { live, messages } = consumer();

  for (let index = 0; index <= 1_000; index += 1) {
    live.messageCreated({ id: `message-${index}`, content: "hello" });
  }

  assert.equal(live.messageCreated({ id: "message-0", content: "hello" }), true);
  assert.equal(messages.length, 1_002);
});
