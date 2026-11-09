import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool } from "../../db.js";
import {
  accountEvents,
  conversations,
  userSyncState,
} from "../../db/schema.js";
import { createChatService } from "../chat/chat.service.js";
import { createReadStateService } from "../read-state/read-state.service.js";
import { createSyncService } from "./sync.service.js";

test("returns isolated contiguous pages, snapshots, and reset signals", async () => {
  const users = [randomUUID(), randomUUID(), randomUUID()];
  const [alice, bob, outsider] = users;
  const conversationIds: string[] = [];
  const chat = createChatService(db);
  const sync = createSyncService(db);
  const reads = createReadStateService(db);

  await pool.query(
    `insert into "user" (id, name, email, "emailVerified") values
      ($1, 'Alice', $4, true), ($2, 'Bob', $5, true), ($3, 'Outsider', $6, true)`,
    [alice, bob, outsider, `${alice}@test.invalid`, `${bob}@test.invalid`, `${outsider}@test.invalid`],
  );

  try {
    const directResult = await chat.createConversation(alice, {
      kind: "direct",
      memberIds: [bob],
    });
    assert.equal(directResult.status, "created");
    if (directResult.status !== "created") return;
    const direct = directResult.conversation;
    conversationIds.push(direct.id);

    const emptyResult = await chat.createConversation(alice, {
      kind: "group",
      memberIds: [bob, outsider],
      title: "Empty",
    });
    assert.equal(emptyResult.status, "created");
    if (emptyResult.status === "created") conversationIds.push(emptyResult.conversation.id);

    for (let sequence = 1; sequence <= 55; sequence += 1) {
      const result = await chat.sendMessage(alice, direct.id, {
        clientMessageId: randomUUID(),
        content: `message ${sequence}`,
      });
      assert.equal(result.status, "sent");
    }

    const first = await sync.getEvents(bob, 0, 20);
    assert.equal(first.resetRequired, false);
    assert.deepEqual(
      first.events.map(({ sequence }) => sequence),
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    assert.equal(first.nextToken, 20);
    assert.equal(first.hasMore, true);
    assert.equal(
      (first.events[0].payload as { conversation: { id: string } }).conversation.id,
      direct.id,
    );

    const second = await sync.getEvents(bob, first.nextToken, 40);
    assert.equal(second.resetRequired, false);
    assert.deepEqual(
      second.events.map(({ sequence }) => sequence),
      Array.from({ length: 35 }, (_, index) => index + 21),
    );
    assert.equal(second.nextToken, 55);
    assert.equal(second.hasMore, false);

    assert.deepEqual(await sync.getEvents(bob, 55, 100), {
      mode: "events",
      events: [],
      nextToken: 55,
      hasMore: false,
      resetRequired: false,
    });
    assert.deepEqual(await sync.getEvents(outsider, 0, 100), {
      mode: "events",
      events: [],
      nextToken: 0,
      hasMore: false,
      resetRequired: false,
    });
    assert.deepEqual(await sync.getEvents(bob, 56, 100), {
      mode: "events",
      events: [],
      nextToken: 56,
      hasMore: false,
      resetRequired: true,
    });

    const snapshot = await sync.getSnapshot(bob);
    assert.equal(snapshot.nextToken, 55);
    assert.equal(snapshot.conversations.length, 1);
    assert.equal(snapshot.conversations[0].id, direct.id);
    assert.deepEqual(snapshot.conversations[0].memberIds, [alice, bob].sort());
    assert.deepEqual(snapshot.conversations[0].members, [
      { id: alice, name: "Alice", email: `${alice}@test.invalid` },
      { id: bob, name: "Bob", email: `${bob}@test.invalid` },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    assert.equal(snapshot.conversations[0].lastReadSequence, 0);
    assert.deepEqual(
      snapshot.conversations[0].messages.map(({ sequence }) => sequence),
      Array.from({ length: 50 }, (_, index) => index + 6),
    );
    assert.match(snapshot.conversations[0].messages[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);

    const beforeConcurrentMessage = await sync.getEvents(bob, 55, 100);
    const later = await chat.sendMessage(alice, direct.id, {
      clientMessageId: randomUUID(),
      content: "later message",
    });
    assert.equal(later.status, "sent");
    assert.equal(beforeConcurrentMessage.nextToken, 55);
    const afterConcurrentMessage = await sync.getEvents(bob, 55, 100);
    assert.deepEqual(
      afterConcurrentMessage.events.map(({ sequence }) => sequence),
      [56],
    );

    assert.deepEqual(await reads.markRead(bob, direct.id, 10), {
      status: "read",
      lastReadSequence: 10,
      advanced: true,
    });
    const readPage = await sync.getEvents(bob, 56, 100);
    assert.equal(readPage.resetRequired, false);
    assert.deepEqual(readPage.events.map(({ type, sequence, payload }) => ({ type, sequence, payload })), [
      {
        type: "conversation.read",
        sequence: 57,
        payload: { conversationId: direct.id, lastReadSequence: 10 },
      },
    ]);
    const readSnapshot = await sync.getSnapshot(bob);
    assert.equal(readSnapshot.conversations[0].lastReadSequence, 10);

    await db
      .delete(accountEvents)
      .where(and(eq(accountEvents.userId, bob), eq(accountEvents.sequence, 2)));
    assert.deepEqual(await sync.getEvents(bob, 0, 100), {
      mode: "events",
      events: [],
      nextToken: 0,
      hasMore: false,
      resetRequired: true,
    });
  } finally {
    if (conversationIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    await db.delete(userSyncState).where(inArray(userSyncState.userId, users));
    await pool.query('delete from "user" where id = any($1)', [users]);
    await pool.end();
  }
});
