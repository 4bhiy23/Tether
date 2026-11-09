import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AccountEvent, Conversation, Message } from "./chat-types";
import { createLiveEventConsumer } from "./live-events";

const createdAt = "2026-11-03T10:00:00.000Z";

function records() {
  const conversation: Conversation = {
    id: randomUUID(),
    kind: "direct",
    title: null,
    memberIds: ["alice", "bob"],
    members: [
      { id: "alice", name: "Alice", email: "alice@test.invalid" },
      { id: "bob", name: "Bob", email: "bob@test.invalid" },
    ],
    createdAt,
  };
  const message: Message = {
    id: randomUUID(),
    conversationId: conversation.id,
    sequence: 1,
    senderId: "alice",
    clientMessageId: randomUUID(),
    content: "hello",
    createdAt,
  };
  const event: AccountEvent = {
    id: randomUUID(),
    userId: "bob",
    sequence: 1,
    type: "message.created",
    conversationId: conversation.id,
    messageId: message.id,
    payload: { conversation, message },
    createdAt,
  };
  return { event, message };
}

test("validates live messages and account events before dispatch", async () => {
  const messages: Message[] = [];
  const events: AccountEvent[] = [];
  const consumer = createLiveEventConsumer({
    onMessage: (message) => {
      messages.push(message);
    },
    onAccountEvent: (event) => {
      events.push(event);
    },
  });
  const { event, message } = records();

  assert.equal(await consumer.messageCreated(message), true);
  assert.equal(await consumer.accountEvent(event), true);
  assert.deepEqual(messages, [message]);
  assert.deepEqual(events, [event]);
});

test("rejects malformed live payloads", async () => {
  let calls = 0;
  const consumer = createLiveEventConsumer({
    onMessage: () => {
      calls += 1;
    },
    onAccountEvent: () => {
      calls += 1;
    },
  });

  assert.equal(await consumer.messageCreated({ id: "invalid" }), false);
  assert.equal(await consumer.accountEvent({ sequence: 1 }), false);
  assert.equal(calls, 0);
});
