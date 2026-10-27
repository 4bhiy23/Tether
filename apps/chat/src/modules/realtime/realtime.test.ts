import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "socket.io";
import { dispatchOutboxEnvelope } from "./realtime.js";

test("dispatches a valid outbox envelope to local conversation and user rooms", () => {
  const calls: unknown[][] = [];
  const io = {
    local: {
      to(room: string) {
        return {
          emit(event: string, payload: unknown) {
            calls.push([room, event, payload]);
          },
        };
      },
    },
  } as unknown as Server;
  const message = {
    id: "00000000-0000-4000-8000-000000000001",
    conversationId: "00000000-0000-4000-8000-000000000002",
    sequence: 1,
    senderId: "alice",
    clientMessageId: "00000000-0000-4000-8000-000000000003",
    content: "hello",
    createdAt: "2026-10-27T00:00:00.000Z",
  };
  const accountEvent = {
    id: "00000000-0000-4000-8000-000000000004",
    userId: "bob",
    sequence: 1,
    type: "message.created",
    conversationId: message.conversationId,
    messageId: message.id,
    payload: message,
    createdAt: "2026-10-27T00:00:00.000Z",
  };

  assert.equal(
    dispatchOutboxEnvelope(
      io,
      JSON.stringify({
        version: 1,
        outboxId: "00000000-0000-4000-8000-000000000005",
        message,
        accountEvents: [accountEvent],
      }),
    ),
    true,
  );
  assert.deepEqual(calls, [
    [`conversation:${message.conversationId}`, "message.created", message],
    ["user:bob", "account.event", accountEvent],
  ]);
});

test("rejects malformed outbox envelopes", () => {
  const io = {} as Server;
  assert.equal(dispatchOutboxEnvelope(io, "not json"), false);
  assert.equal(dispatchOutboxEnvelope(io, JSON.stringify({ version: 2 })), false);
});
