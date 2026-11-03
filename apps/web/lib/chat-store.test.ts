import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import type { AccountEvent, Conversation, Message, SnapshotConversation } from "./chat-types";
import { openChatStore } from "./chat-store";

const createdAt = "2026-11-03T10:00:00.000Z";

function records(sequence = 1) {
  const conversation: Conversation = {
    id: randomUUID(),
    kind: "direct",
    title: null,
    memberIds: ["alice", "bob"],
    createdAt,
  };
  const message: Message = {
    id: randomUUID(),
    conversationId: conversation.id,
    sequence,
    senderId: "alice",
    clientMessageId: randomUUID(),
    content: `message ${sequence}`,
    createdAt,
  };
  const event: AccountEvent = {
    id: randomUUID(),
    userId: "bob",
    sequence,
    type: "message.created",
    conversationId: conversation.id,
    messageId: message.id,
    payload: { conversation, message },
    createdAt,
  };
  return { conversation, event, message };
}

async function withStore(
  run: (store: Awaited<ReturnType<typeof openChatStore>>) => Promise<void>,
) {
  const userId = randomUUID();
  const name = `tether-chat:${userId}`;
  const store = await openChatStore(userId);
  try {
    await run(store);
  } finally {
    store.close();
    await deleteDB(name);
  }
}

test("keeps a missing token distinct from stored zero", async () => {
  await withStore(async (store) => {
    assert.equal(await store.getSyncToken(), undefined);
    assert.equal((await store.replaceSnapshot([], 0, undefined)).status, "applied");
    assert.equal(await store.getSyncToken(), 0);
  });
});

test("atomically materializes contiguous events and advances the token", async () => {
  await withStore(async (store) => {
    const { conversation, event, message } = records();
    await store.replaceSnapshot([], 0, undefined);

    assert.deepEqual(await store.applyEventPage(0, [event], 1), {
      status: "applied",
      token: 1,
    });
    assert.deepEqual(await store.getConversation(conversation.id), conversation);
    assert.deepEqual(await store.getMessage(message.id), message);
    assert.equal(await store.getSyncToken(), 1);
  });
});

test("rejects an event page that skips the expected next sequence", async () => {
  await withStore(async (store) => {
    const { event } = records(2);
    await store.replaceSnapshot([], 0, undefined);

    await assert.rejects(store.applyEventPage(0, [event], 2), /Invalid event page sequence/);
    assert.equal(await store.getSyncToken(), 0);
  });
});

test("rolls back materialized data and token when an event write fails", async () => {
  await withStore(async (store) => {
    const { event, message } = records();
    await store.replaceSnapshot([], 0, undefined);
    const invalid = {
      ...event,
      payload: { ...event.payload, conversation: { ...event.payload.conversation, id: undefined } },
    } as unknown as AccountEvent;

    await assert.rejects(store.applyEventPage(0, [invalid], 1));
    assert.equal(await store.getMessage(message.id), undefined);
    assert.equal(await store.getSyncToken(), 0);
  });
});

test("deduplicates repeated pages and overlapping history by message ID", async () => {
  await withStore(async (store) => {
    const { event, message } = records();
    await store.replaceSnapshot([], 0, undefined);
    await store.applyEventPage(0, [event], 1);

    assert.equal((await store.applyEventPage(0, [event], 1)).status, "stale");
    await store.storeHistory([message, message]);
    assert.equal((await store.getMessages()).length, 1);
  });
});

test("rejects stale snapshots and atomically replaces current state", async () => {
  await withStore(async (store) => {
    const old = records();
    const next = records(2);
    await store.replaceSnapshot([{ ...old.conversation, messages: [old.message] }], 1, undefined);

    assert.equal((await store.replaceSnapshot([], 0, undefined)).status, "stale");
    assert.deepEqual(await store.getMessage(old.message.id), old.message);
    assert.equal(await store.getSyncToken(), 1);

    const snapshot: SnapshotConversation[] = [
      { ...next.conversation, messages: [next.message] },
    ];
    assert.equal((await store.replaceSnapshot(snapshot, 2, 1)).status, "applied");
    assert.equal(await store.getMessage(old.message.id), undefined);
    assert.deepEqual(await store.getMessage(next.message.id), next.message);
    assert.equal(await store.getSyncToken(), 2);
  });
});

test("isolates user databases", async () => {
  const firstId = randomUUID();
  const secondId = randomUUID();
  const first = await openChatStore(firstId);
  const second = await openChatStore(secondId);
  const { message } = records();
  try {
    await first.storeRoomMessage(message);
    assert.deepEqual(await first.getMessage(message.id), message);
    assert.equal(await second.getMessage(message.id), undefined);
  } finally {
    first.close();
    second.close();
    await Promise.all([
      deleteDB(`tether-chat:${firstId}`),
      deleteDB(`tether-chat:${secondId}`),
    ]);
  }
});

test("room and history writes never advance the account token", async () => {
  await withStore(async (store) => {
    const first = records();
    const second = records(2);
    await store.replaceSnapshot([], 7, undefined);

    await store.storeRoomMessage(first.message);
    await store.storeHistory([second.message]);
    assert.equal(await store.getSyncToken(), 7);
  });
});
