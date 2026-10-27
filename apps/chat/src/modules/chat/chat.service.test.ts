import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool } from "../../db.js";
import {
  accountEvents,
  conversationMembers,
  conversations,
  messages,
  outboxEvents,
  userSyncState,
} from "../../db/schema.js";
import { createChatService } from "./chat.service.js";

test("writes messages, account events, and outbox records atomically and idempotently", async () => {
  const users = [randomUUID(), randomUUID(), randomUUID()];
  const [alice, bob, outsider] = users;
  const chat = createChatService(db);
  const otherServer = createChatService(db);
  const conversationIds: string[] = [];

  await pool.query(
    `insert into "user" (id, name, email, "emailVerified") values
      ($1, 'Alice', $4, true), ($2, 'Bob', $5, true), ($3, 'Outsider', $6, true)`,
    [alice, bob, outsider, `${alice}@test.invalid`, `${bob}@test.invalid`, `${outsider}@test.invalid`],
  );

  try {
    const [directResult, duplicateDirectResult] = await Promise.all([
      chat.createConversation(alice, { kind: "direct", memberIds: [bob] }),
      otherServer.createConversation(bob, { kind: "direct", memberIds: [alice] }),
    ]);
    assert.equal(directResult.status, "created");
    assert.equal(duplicateDirectResult.status, "created");
    if (directResult.status !== "created") return;
    if (duplicateDirectResult.status !== "created") return;
    const direct = directResult.conversation;
    conversationIds.push(direct.id);
    assert.equal(duplicateDirectResult.conversation.id, direct.id);
    assert.deepEqual(direct.memberIds, [alice, bob].sort());

    const groupResult = await chat.createConversation(alice, {
      kind: "group",
      title: "Test group",
      memberIds: [bob, outsider],
    });
    assert.equal(groupResult.status, "created");
    if (groupResult.status !== "created") return;
    const group = groupResult.conversation;
    conversationIds.push(group.id);
    assert.deepEqual(group.memberIds, [alice, bob, outsider].sort());

    assert.deepEqual(
      await chat.createConversation(alice, { kind: "direct", memberIds: [randomUUID()] }),
      { status: "invalid-members" },
    );
    assert.deepEqual(await chat.createConversation(alice, { kind: "direct", memberIds: [] }), {
      status: "invalid-members",
    });
    assert.deepEqual(await chat.createConversation(alice, { kind: "group", memberIds: [bob] }), {
      status: "invalid-members",
    });
    assert.equal(
      (
        await db
          .select()
          .from(conversationMembers)
          .where(eq(conversationMembers.userId, alice))
      ).length,
      2,
    );

    assert.deepEqual(
      await chat.sendMessage(outsider, direct.id, {
        clientMessageId: randomUUID(),
        content: "not allowed",
      }),
      { status: "forbidden" },
    );

    const clientMessageId = randomUUID();
    const results = await Promise.all([
      chat.sendMessage(alice, direct.id, { clientMessageId, content: "hello" }),
      otherServer.sendMessage(alice, direct.id, { clientMessageId, content: "hello" }),
    ]);
    assert.deepEqual(
      results.map((result) => result.status === "sent" && result.replayed).sort(),
      [false, true],
    );

    const storedMessages = await db
      .select()
      .from(messages)
      .where(and(eq(messages.senderId, alice), eq(messages.clientMessageId, clientMessageId)));
    assert.equal(storedMessages.length, 1);
    assert.equal(storedMessages[0].sequence, 1);

    const events = await db
      .select()
      .from(accountEvents)
      .where(eq(accountEvents.messageId, storedMessages[0].id));
    assert.deepEqual(
      events.map(({ userId, sequence }) => ({ userId, sequence })).sort((a, b) => a.userId.localeCompare(b.userId)),
      [
        { userId: alice, sequence: 1 },
        { userId: bob, sequence: 1 },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    );
    assert.equal(
      (await db.select().from(outboxEvents).where(eq(outboxEvents.messageId, storedMessages[0].id)))
        .length,
      1,
    );
    assert.deepEqual(
      await otherServer.sendMessage(alice, direct.id, {
        clientMessageId,
        content: "different content",
      }),
      { status: "idempotency-conflict" },
    );

    const eventCountBeforeFailure = (
      await db.select().from(accountEvents).where(eq(accountEvents.conversationId, direct.id))
    ).length;
    const outboxCountBeforeFailure = (await db.select().from(outboxEvents)).length;
    await pool.query(
      "alter table outbox_events add constraint test_reject_outbox check (false) not valid",
    );
    const failedClientMessageId = randomUUID();
    try {
      await assert.rejects(
        chat.sendMessage(alice, direct.id, {
          clientMessageId: failedClientMessageId,
          content: "must roll back",
        }),
      );
    } finally {
      await pool.query("alter table outbox_events drop constraint test_reject_outbox");
    }

    assert.equal(
      (
        await db
          .select()
          .from(messages)
          .where(eq(messages.clientMessageId, failedClientMessageId))
      ).length,
      0,
    );
    const [storedConversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, direct.id));
    assert.equal(storedConversation.nextMessageSequence, 1);
    assert.equal(
      (await db.select().from(accountEvents).where(eq(accountEvents.conversationId, direct.id)))
        .length,
      eventCountBeforeFailure,
    );
    assert.equal((await db.select().from(outboxEvents)).length, outboxCountBeforeFailure);
  } finally {
    if (conversationIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    await db.delete(userSyncState).where(inArray(userSyncState.userId, users));
    await db.delete(conversationMembers).where(inArray(conversationMembers.userId, users));
    await pool.query('delete from "user" where id = any($1)', [users]);
    await pool.end();
  }
});
