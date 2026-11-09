import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool } from "../../db.js";
import {
  accountEvents,
  conversationReadState,
  conversations,
  outboxEvents,
  userSyncState,
} from "../../db/schema.js";
import { createChatService } from "../chat/chat.service.js";
import { createReadStateService } from "./read-state.service.js";

test("advances read state atomically and monotonically", async () => {
  const users = [randomUUID(), randomUUID(), randomUUID()];
  const [alice, bob, outsider] = users;
  const chat = createChatService(db);
  const reads = createReadStateService(db);
  let conversationId: string | undefined;
  await pool.query(
    `insert into "user" (id, name, email, "emailVerified") values
      ($1, 'Alice', $4, true), ($2, 'Bob', $5, true), ($3, 'Outsider', $6, true)`,
    [alice, bob, outsider, `${alice}@test.invalid`, `${bob}@test.invalid`, `${outsider}@test.invalid`],
  );

  try {
    const created = await chat.createConversation(alice, { kind: "direct", memberIds: [bob] });
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    conversationId = created.conversation.id;
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      assert.equal(
        (
          await chat.sendMessage(alice, conversationId, {
            clientMessageId: randomUUID(),
            content: `message ${sequence}`,
          })
        ).status,
        "sent",
      );
    }

    assert.deepEqual(await reads.markRead(outsider, conversationId, 1), { status: "forbidden" });
    assert.deepEqual(await reads.markRead(bob, conversationId, 4), { status: "invalid-sequence" });
    assert.deepEqual(await reads.markRead(bob, conversationId, 2), {
      status: "read",
      lastReadSequence: 2,
      advanced: true,
    });
    assert.deepEqual(await reads.markRead(bob, conversationId, 1), {
      status: "read",
      lastReadSequence: 2,
      advanced: false,
    });

    const readEvents = await db
      .select()
      .from(accountEvents)
      .where(and(eq(accountEvents.userId, bob), eq(accountEvents.type, "conversation.read")));
    assert.equal(readEvents.length, 1);
    assert.equal(readEvents[0].messageId, null);
    assert.deepEqual(readEvents[0].payload, {
      conversationId,
      lastReadSequence: 2,
    });
    assert.equal(
      (
        await db
          .select()
          .from(outboxEvents)
          .where(eq(outboxEvents.accountEventId, readEvents[0].id))
      ).length,
      1,
    );

    await pool.query(
      "alter table outbox_events add constraint test_reject_read_outbox check (false) not valid",
    );
    try {
      await assert.rejects(reads.markRead(bob, conversationId, 3));
    } finally {
      await pool.query("alter table outbox_events drop constraint test_reject_read_outbox");
    }
    assert.equal(
      (
        await db
          .select()
          .from(conversationReadState)
          .where(
            and(
              eq(conversationReadState.conversationId, conversationId),
              eq(conversationReadState.userId, bob),
            ),
          )
      )[0].lastReadSequence,
      2,
    );
    assert.equal(
      (
        await db
          .select()
          .from(accountEvents)
          .where(and(eq(accountEvents.userId, bob), eq(accountEvents.type, "conversation.read")))
      ).length,
      1,
    );

    const concurrent = await Promise.all([
      reads.markRead(bob, conversationId, 3),
      createReadStateService(db).markRead(bob, conversationId, 3),
    ]);
    assert.deepEqual(
      concurrent.map((result) => result.status === "read" && result.advanced).sort(),
      [false, true],
    );
    assert.equal(
      (
        await db
          .select()
          .from(accountEvents)
          .where(and(eq(accountEvents.userId, bob), eq(accountEvents.type, "conversation.read")))
      ).length,
      2,
    );
  } finally {
    if (conversationId) await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(userSyncState).where(inArray(userSyncState.userId, users));
    await pool.query('delete from "user" where id = any($1)', [users]);
    await pool.end();
  }
});
