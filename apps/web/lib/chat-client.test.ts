import assert from "node:assert/strict";
import test from "node:test";
import {
  createOptimisticQueue,
  createReadCoordinator,
  createTypingTracker,
  rejoinActiveConversation,
} from "./chat-client";

test("rejoins the active conversation after a socket reconnect", () => {
  const emitted: unknown[] = [];
  const socket = {
    emit(event: string, payload: unknown) {
      emitted.push([event, payload]);
      return true;
    },
  };

  rejoinActiveConversation(socket, "00000000-0000-4000-8000-000000000001");
  rejoinActiveConversation(socket);

  assert.deepEqual(emitted, [[
    "conversation.join",
    { conversationId: "00000000-0000-4000-8000-000000000001" },
  ]]);
});

test("optimistic failure and retry reuse the same client message id", async () => {
  const delivered: string[] = [];
  let fail = true;
  const queue = createOptimisticQueue({
    senderId: "alice",
    createId: () => "00000000-0000-4000-8000-000000000001",
    now: () => "2026-11-04T10:00:00.000Z",
    onChange: () => {},
    async deliver(message) {
      delivered.push(message.clientMessageId);
      if (fail) throw new Error("offline");
      return message;
    },
  });

  await assert.rejects(queue.send("conversation", "hello"), /offline/);
  const [failed] = queue.get("conversation");
  assert.equal(failed.status, "failed");
  fail = false;
  await queue.retry(failed.clientMessageId);

  assert.deepEqual(delivered, [failed.clientMessageId, failed.clientMessageId]);
  assert.deepEqual(queue.get("conversation"), []);
});

test("read updates skip seen messages, coalesce forward, and retain failures for retry", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const requested: number[] = [];
  const confirmed: number[] = [];
  let current = 1;
  let fail = false;
  const coordinator = createReadCoordinator({
    current: async () => current,
    async update(_conversationId, sequence) {
      requested.push(sequence);
      if (sequence === 2) await waiting;
      if (fail) throw new Error("offline");
      return sequence;
    },
    confirmed: (_conversationId, sequence) => {
      current = sequence;
      confirmed.push(sequence);
    },
  });

  await coordinator.propose("conversation", 1);
  assert.deepEqual(requested, []);

  const first = coordinator.propose("conversation", 2);
  void coordinator.propose("conversation", 4);
  release();
  await first;
  assert.deepEqual(requested, [2, 4]);
  assert.deepEqual(confirmed, [2, 4]);

  fail = true;
  await coordinator.propose("conversation", 5);
  fail = false;
  await coordinator.retry();
  assert.deepEqual(requested, [2, 4, 5, 5]);
  assert.deepEqual(confirmed, [2, 4, 5]);

  await coordinator.propose("conversation", 4);
  assert.deepEqual(requested, [2, 4, 5, 5]);

  fail = true;
  await coordinator.propose("conversation", 6);
  current = 6;
  fail = false;
  await coordinator.retry();
  assert.deepEqual(requested, [2, 4, 5, 5, 6]);
});

test("typing participants refresh, stop, and expire locally", () => {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const tracker = createTypingTracker({
    onChange: () => {},
    timers: {
      setTimeout: ((callback: () => void) => {
        nextId += 1;
        callbacks.set(nextId, callback);
        return nextId;
      }) as typeof window.setTimeout,
      clearTimeout: (id) => { if (id !== undefined) callbacks.delete(id); },
    },
  });

  tracker.apply({ conversationId: "00000000-0000-4000-8000-000000000001", userId: "alice", isTyping: true });
  assert.deepEqual(tracker.get("00000000-0000-4000-8000-000000000001"), ["alice"]);
  callbacks.get(1)?.();
  assert.deepEqual(tracker.get("00000000-0000-4000-8000-000000000001"), []);

  tracker.apply({ conversationId: "00000000-0000-4000-8000-000000000001", userId: "alice", isTyping: true });
  tracker.apply({ conversationId: "00000000-0000-4000-8000-000000000001", userId: "alice", isTyping: false });
  assert.deepEqual(tracker.get("00000000-0000-4000-8000-000000000001"), []);
});
