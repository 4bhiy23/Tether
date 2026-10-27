import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Socket } from "socket.io";
import { createSocketController } from "./socket.controller.js";

type Listener = (input: unknown, callback: (result: unknown) => void) => Promise<void> | void;

function fakeSocket() {
  const joined: string[] = [];
  const left: string[] = [];
  const emitted: string[] = [];
  const listeners = new Map<string, Listener>();
  const socket = {
    data: { sessionId: "session-1", userId: "user-1" },
    join: async (rooms: string | string[]) => {
      joined.push(...(Array.isArray(rooms) ? rooms : [rooms]));
    },
    leave: async (room: string) => {
      left.push(room);
    },
    emit: (event: string) => {
      emitted.push(event);
    },
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener);
    },
  } as unknown as Socket;

  async function invoke(event: string, input: unknown) {
    let result: unknown;
    await listeners.get(event)!(input, (value) => {
      result = value;
    });
    return result;
  }

  return { socket, joined, left, emitted, invoke };
}

test("joins authenticated session and user rooms", async () => {
  const fake = fakeSocket();
  const controller = createSocketController({
    getConversationAccess: async () => ({ status: "member" }),
  });

  await controller.connected(fake.socket);

  assert.deepEqual(fake.joined, ["session:session-1", "user:user-1"]);
  assert.deepEqual(fake.emitted, ["chat.ready"]);
});

test("authorizes conversation joins and validates join and leave payloads", async () => {
  const conversationId = randomUUID();
  const checked: unknown[] = [];
  const fake = fakeSocket();
  const controller = createSocketController({
    getConversationAccess: async (...args) => {
      checked.push(args);
      return { status: "member" };
    },
  });
  await controller.connected(fake.socket);

  assert.deepEqual(await fake.invoke("conversation.join", { conversationId: "invalid" }), {
    status: "invalid",
  });
  assert.deepEqual(await fake.invoke("conversation.join", { conversationId }), {
    status: "joined",
  });
  assert.deepEqual(checked, [["user-1", conversationId]]);
  assert.equal(fake.joined.at(-1), `conversation:${conversationId}`);

  assert.deepEqual(await fake.invoke("conversation.leave", { conversationId: "invalid" }), {
    status: "invalid",
  });
  assert.deepEqual(await fake.invoke("conversation.leave", { conversationId }), {
    status: "left",
  });
  assert.deepEqual(fake.left, [`conversation:${conversationId}`]);
});

test("rejects unauthorized joins and hides membership failures", async () => {
  const conversationId = randomUUID();

  for (const status of ["not-found", "forbidden"] as const) {
    const fake = fakeSocket();
    const controller = createSocketController({
      getConversationAccess: async () => ({ status }),
    });
    await controller.connected(fake.socket);

    assert.deepEqual(await fake.invoke("conversation.join", { conversationId }), { status });
    assert.ok(!fake.joined.includes(`conversation:${conversationId}`));
  }

  const unavailable = fakeSocket();
  const controller = createSocketController({
    getConversationAccess: async () => {
      throw new Error("database unavailable");
    },
  });
  await controller.connected(unavailable.socket);

  assert.deepEqual(await unavailable.invoke("conversation.join", { conversationId }), {
    status: "unavailable",
  });
});
