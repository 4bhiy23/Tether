import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pool } from "../../db.js";

test("backfills old account-event payloads without changing enriched rows", async () => {
  const client = await pool.connect();
  const [alice, bob] = [randomUUID(), randomUUID()].sort();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const oldEventId = randomUUID();
  const enrichedEventId = randomUUID();
  const alreadyEnriched = {
    message: { marker: "keep-message" },
    conversation: { marker: "keep-conversation" },
  };
  const migration = await readFile(
    new URL("../../../drizzle/0003_backfill_account_event_payloads.sql", import.meta.url),
    "utf8",
  );

  try {
    await client.query("begin");
    await client.query(
      `insert into "user" (id, name, email, "emailVerified") values
        ($1, 'Alice', $3, true), ($2, 'Bob', $4, true)`,
      [alice, bob, `${alice}@test.invalid`, `${bob}@test.invalid`],
    );
    await client.query(
      `insert into conversations (id, kind, created_by)
       values ($1, 'direct', $2)`,
      [conversationId, alice],
    );
    await client.query(
      `insert into conversation_members (conversation_id, user_id)
       values ($1, $2), ($1, $3)`,
      [conversationId, bob, alice],
    );
    await client.query(
      `insert into messages
        (id, conversation_id, sequence, sender_id, client_message_id, content)
       values ($1, $2, 1, $3, $4, 'hello')`,
      [messageId, conversationId, alice, randomUUID()],
    );
    await client.query(
      `insert into account_events
        (id, user_id, sequence, type, conversation_id, message_id, payload)
       values
        ($1, $2, 1, 'message.created', $3, $4, $5::jsonb),
        ($6, $7, 1, 'message.created', $3, $4, $8::jsonb)`,
      [
        oldEventId,
        alice,
        conversationId,
        messageId,
        JSON.stringify({ id: messageId, content: "hello" }),
        enrichedEventId,
        bob,
        JSON.stringify(alreadyEnriched),
      ],
    );

    await client.query(migration);
    await client.query(migration);
    const result = await client.query<{ id: string; payload: unknown }>(
      "select id, payload from account_events where id = any($1) order by id",
      [[oldEventId, enrichedEventId]],
    );
    const payloads = new Map(result.rows.map(({ id, payload }) => [id, payload]));
    const oldPayload = payloads.get(oldEventId) as {
      message: { id: string; conversationId: string; createdAt: string };
      conversation: { id: string; memberIds: string[]; createdAt: string };
    };

    assert.equal(oldPayload.message.id, messageId);
    assert.equal(oldPayload.message.conversationId, conversationId);
    assert.equal(typeof oldPayload.message.createdAt, "string");
    assert.equal(oldPayload.conversation.id, conversationId);
    assert.deepEqual(oldPayload.conversation.memberIds, [alice, bob]);
    assert.equal(typeof oldPayload.conversation.createdAt, "string");
    assert.deepEqual(payloads.get(enrichedEventId), alreadyEnriched);
  } finally {
    await client.query("rollback");
    client.release();
    await pool.end();
  }
});
