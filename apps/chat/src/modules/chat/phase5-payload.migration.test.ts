import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pool } from "../../db.js";

test("backfills sorted member profiles into existing message events", async () => {
  const client = await pool.connect();
  const [alice, bob] = [randomUUID(), randomUUID()].sort();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const migration = await readFile(
    new URL("../../../drizzle/0004_mixed_violations.sql", import.meta.url),
    "utf8",
  );
  const backfill = migration.split("--> statement-breakpoint").at(-1)?.trim();
  if (!backfill?.startsWith("UPDATE \"account_events\"")) {
    assert.fail("Phase 5 payload backfill is missing");
  }

  try {
    await client.query("begin");
    await client.query(
      `insert into "user" (id, name, email, "emailVerified") values
        ($1, 'Alice', $3, true), ($2, 'Bob', $4, true)`,
      [alice, bob, `${alice}@test.invalid`, `${bob}@test.invalid`],
    );
    await client.query(
      `insert into conversations (id, kind, created_by) values ($1, 'direct', $2)`,
      [conversationId, alice],
    );
    await client.query(
      `insert into conversation_members (conversation_id, user_id) values ($1, $2), ($1, $3)`,
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
        (user_id, sequence, type, conversation_id, message_id, payload)
       values ($1, 1, 'message.created', $2, $3, $4::jsonb)`,
      [
        alice,
        conversationId,
        messageId,
        JSON.stringify({
          message: { id: messageId },
          conversation: { id: conversationId, memberIds: [alice, bob] },
        }),
      ],
    );
    await client.query(backfill);
    await client.query(backfill);
    const result = await client.query<{ members: unknown }>(
      `select payload->'conversation'->'members' as members
       from account_events where user_id = $1 and sequence = 1`,
      [alice],
    );
    assert.deepEqual(result.rows[0].members, [
      { id: alice, name: "Alice", email: `${alice}@test.invalid` },
      { id: bob, name: "Bob", email: `${bob}@test.invalid` },
    ]);
  } finally {
    await client.query("rollback");
    client.release();
    await pool.end();
  }
});
