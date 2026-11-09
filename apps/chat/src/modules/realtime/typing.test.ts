import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Socket } from "socket.io";
import { registerTypingHandlers } from "./typing.js";

type Listener = (...args: unknown[]) => void;

function fakeSocket(conversationId: string) {
  const listeners = new Map<string, Listener>();
  const emitted: unknown[][] = [];
  const socket = {
    data: { userId: "alice" },
    rooms: new Set([`conversation:${conversationId}`]),
    on: (event: string, listener: Listener) => listeners.set(event, listener),
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => emitted.push([room, event, payload]),
    }),
  } as unknown as Socket;

  function invoke(event: string, input: unknown) {
    let result: unknown;
    listeners.get(event)!(input, (value: unknown) => {
      result = value;
    });
    return result;
  }

  return { socket, emitted, invoke, disconnect: () => listeners.get("disconnect")!() };
}

test("broadcasts authorized typing and rate limits start pulses", () => {
  const conversationId = randomUUID();
  let now = 1_000;
  const fake = fakeSocket(conversationId);
  registerTypingHandlers(fake.socket, () => now);

  assert.deepEqual(fake.invoke("typing.start", { conversationId: "invalid" }), {
    status: "invalid",
  });
  assert.deepEqual(fake.invoke("typing.start", { conversationId: randomUUID() }), {
    status: "forbidden",
  });
  assert.deepEqual(fake.invoke("typing.start", { conversationId }), { status: "sent" });
  assert.deepEqual(fake.invoke("typing.start", { conversationId }), {
    status: "rate-limited",
  });
  now += 1_000;
  assert.deepEqual(fake.invoke("typing.start", { conversationId }), { status: "sent" });
  assert.deepEqual(fake.emitted.at(-1), [
    `conversation:${conversationId}`,
    "typing.changed",
    { conversationId, userId: "alice", isTyping: true },
  ]);

  assert.deepEqual(fake.invoke("typing.stop", { conversationId }), { status: "sent" });
  assert.deepEqual(fake.emitted.at(-1), [
    `conversation:${conversationId}`,
    "typing.changed",
    { conversationId, userId: "alice", isTyping: false },
  ]);
  fake.disconnect();
});
