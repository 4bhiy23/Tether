import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { db, pool } from "../../db.js";
import {
  accountEvents,
  conversationMembers,
  conversations,
  messages,
  outboxEvents,
} from "../../db/schema.js";
import {
  OUTBOX_CHANNEL,
  outboxEnvelopeSchema,
  publishOutboxBatch,
  runOutboxPublisher,
} from "./outbox.publisher.js";

test("publishes pending outbox rows atomically and claims them once", async () => {
  const users = [randomUUID(), randomUUID()];
  const [alice, bob] = users;
  const conversationIds: string[] = [];
  let nextAccountSequence = 0;

  await pool.query(
    `insert into "user" (id, name, email, "emailVerified") values
      ($1, 'Alice', $3, true), ($2, 'Bob', $4, true)`,
    [alice, bob, `${alice}@test.invalid`, `${bob}@test.invalid`],
  );

  async function addPendingMessage(content: string) {
    nextAccountSequence += 1;
    const [conversation] = await db
      .insert(conversations)
      .values({ kind: "group", createdBy: alice })
      .returning();
    conversationIds.push(conversation.id);
    await db.insert(conversationMembers).values([
      { conversationId: conversation.id, userId: alice },
      { conversationId: conversation.id, userId: bob },
    ]);
    const [message] = await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        sequence: 1,
        senderId: alice,
        clientMessageId: randomUUID(),
        content,
      })
      .returning();
    const eventPayload = {
      message,
      conversation: {
        id: conversation.id,
        kind: conversation.kind,
        title: conversation.title,
        createdAt: conversation.createdAt,
        memberIds: [alice, bob].sort(),
        members: [
          { id: alice, name: "Alice", email: `${alice}@test.invalid` },
          { id: bob, name: "Bob", email: `${bob}@test.invalid` },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      },
    };
    await db.insert(accountEvents).values([
      {
        userId: alice,
        sequence: nextAccountSequence,
        type: "message.created",
        conversationId: conversation.id,
        messageId: message.id,
        payload: eventPayload,
      },
      {
        userId: bob,
        sequence: nextAccountSequence,
        type: "message.created",
        conversationId: conversation.id,
        messageId: message.id,
        payload: eventPayload,
      },
    ]);
    const [outbox] = await db
      .insert(outboxEvents)
      .values({ type: "message.created", messageId: message.id, payload: { message } })
      .returning();
    return outbox;
  }

  try {
    const retryable = await addPendingMessage("retry me");
    await assert.rejects(publishOutboxBatch(async () => 0), /no subscribers/);
    assert.equal(
      (await db.select().from(outboxEvents).where(eq(outboxEvents.id, retryable.id)))[0]
        .publishedAt,
      null,
    );

    let publishedPayload = "";
    assert.equal(
      await publishOutboxBatch(async (channel, payload) => {
        assert.equal(channel, OUTBOX_CHANNEL);
        publishedPayload = payload;
        return 1;
      }),
      1,
    );
    const envelope = outboxEnvelopeSchema.parse(JSON.parse(publishedPayload));
    assert.equal(envelope.type, "message.created");
    if (envelope.type !== "message.created") return;
    assert.equal(envelope.outboxId, retryable.id);
    assert.equal(envelope.accountEvents.length, 2);
    for (const event of envelope.accountEvents) {
      const payload = event.payload as {
        message: { id: string };
        conversation: { id: string; memberIds: string[] };
      };
      assert.equal(payload.message.id, envelope.message.id);
      assert.equal(payload.conversation.id, envelope.message.conversationId);
      assert.deepEqual(payload.conversation.memberIds, [alice, bob].sort());
    }
    assert.ok(
      (await db.select().from(outboxEvents).where(eq(outboxEvents.id, retryable.id)))[0]
        .publishedAt,
    );

    const [readEvent] = await db
      .insert(accountEvents)
      .values({
        userId: bob,
        sequence: 100,
        type: "conversation.read",
        conversationId: envelope.message.conversationId,
        messageId: null,
        payload: { conversationId: envelope.message.conversationId, lastReadSequence: 1 },
      })
      .returning();
    const [readOutbox] = await db
      .insert(outboxEvents)
      .values({
        type: "conversation.read",
        messageId: null,
        accountEventId: readEvent.id,
        payload: readEvent.payload,
      })
      .returning();
    let readPayload = "";
    assert.equal(
      await publishOutboxBatch(async (_channel, payload) => {
        readPayload = payload;
        return 1;
      }),
      1,
    );
    const readEnvelope = outboxEnvelopeSchema.parse(JSON.parse(readPayload));
    assert.equal(readEnvelope.type, "conversation.read");
    if (readEnvelope.type === "conversation.read") {
      assert.equal(readEnvelope.outboxId, readOutbox.id);
      assert.deepEqual(readEnvelope.accountEvent.payload, readEvent.payload);
    }

    await addPendingMessage("claim me once");
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let publishCalls = 0;
    const first = publishOutboxBatch(async () => {
      publishCalls += 1;
      firstStarted();
      await release;
      return 1;
    });
    await started;
    const second = await publishOutboxBatch(async () => {
      publishCalls += 1;
      return 1;
    });
    releaseFirst();
    assert.equal(await first, 1);
    assert.equal(second, 0);
    assert.equal(publishCalls, 1);

    const abort = new AbortController();
    let idleCalls = 0;
    const loop = runOutboxPublisher(
      async () => {
        idleCalls += 1;
        return 0;
      },
      abort.signal,
      { idleDelayMs: 10_000 },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    abort.abort();
    await loop;
    assert.equal(idleCalls, 1);
  } finally {
    if (conversationIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    await pool.query('delete from "user" where id = any($1)', [users]);
    await pool.end();
  }
});
