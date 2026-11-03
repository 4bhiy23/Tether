import assert from "node:assert/strict";
import test from "node:test";
import {
  accountEventSchema,
  historyResponseSchema,
  messageSchema,
  syncEventResponseSchema,
  syncSnapshotResponseSchema,
} from "./chat-types";

const conversationId = "00000000-0000-4000-8000-000000000001";
const messageId = "00000000-0000-4000-8000-000000000002";
const createdAt = "2026-11-03T10:00:00.000Z";

const message = {
  id: messageId,
  conversationId,
  sequence: 1,
  senderId: "alice",
  clientMessageId: "00000000-0000-4000-8000-000000000003",
  content: "hello",
  createdAt,
};

const conversation = {
  id: conversationId,
  kind: "direct" as const,
  title: null,
  memberIds: ["alice", "bob"],
  createdAt,
};

const event = {
  id: "00000000-0000-4000-8000-000000000004",
  userId: "bob",
  sequence: 1,
  type: "message.created" as const,
  conversationId,
  messageId,
  payload: { message, conversation },
  createdAt,
};

test("parses snapshot, event-page, history, and live payloads", () => {
  assert.equal(accountEventSchema.parse(event).id, event.id);
  assert.equal(
    syncEventResponseSchema.parse({
      mode: "events",
      events: [event],
      nextToken: 1,
      hasMore: false,
      resetRequired: false,
    }).nextToken,
    1,
  );
  assert.equal(
    syncSnapshotResponseSchema.parse({
      mode: "snapshot",
      conversations: [{ ...conversation, messages: [message] }],
      nextToken: 1,
      resetRequired: false,
    }).conversations.length,
    1,
  );
  assert.equal(
    historyResponseSchema.parse({ messages: [message], nextBeforeSequence: null, hasMore: false })
      .messages.length,
    1,
  );
  assert.equal(messageSchema.parse(message).id, message.id);
});

test("rejects malformed identifiers, sequences, event types, and nested payloads", () => {
  assert.equal(messageSchema.safeParse({ ...message, id: "not-a-uuid" }).success, false);
  assert.equal(messageSchema.safeParse({ ...message, sequence: 0 }).success, false);
  assert.equal(accountEventSchema.safeParse({ ...event, type: "message.deleted" }).success, false);
  assert.equal(
    accountEventSchema.safeParse({
      ...event,
      payload: { ...event.payload, message: { ...message, id: crypto.randomUUID() } },
    }).success,
    false,
  );
  assert.equal(
    syncSnapshotResponseSchema.safeParse({
      mode: "snapshot",
      conversations: [{ ...conversation, kind: "group", messages: [message] }],
      nextToken: 1,
      resetRequired: false,
    }).success,
    false,
  );
});

test("parses reset-required responses without changing their supplied cursor", () => {
  const response = syncEventResponseSchema.parse({
    mode: "events",
    events: [],
    nextToken: 42,
    hasMore: false,
    resetRequired: true,
  });

  assert.equal(response.nextToken, 42);
  assert.equal(response.resetRequired, true);
});

test("rejects non-contiguous event pages and mismatched next tokens", () => {
  const secondEvent = { ...event, id: crypto.randomUUID(), sequence: 3 };
  assert.equal(
    syncEventResponseSchema.safeParse({
      mode: "events",
      events: [event, secondEvent],
      nextToken: 3,
      hasMore: false,
      resetRequired: false,
    }).success,
    false,
  );
  assert.equal(
    syncEventResponseSchema.safeParse({
      mode: "events",
      events: [event],
      nextToken: 2,
      hasMore: false,
      resetRequired: false,
    }).success,
    false,
  );
});
