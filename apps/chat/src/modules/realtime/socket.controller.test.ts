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
  const listeners = new Map<string, Listener[]>();
  const socket = {
    id: "socket-1",
    data: { sessionId: "session-1", userId: "user-1" },
    rooms: new Set<string>(),
    join: async (rooms: string | string[]) => {
      const values = Array.isArray(rooms) ? rooms : [rooms];
      joined.push(...values);
      values.forEach((room) => socket.rooms.add(room));
    },
    leave: async (room: string) => {
      left.push(room);
      socket.rooms.delete(room);
    },
    emit: (event: string) => {
      emitted.push(event);
    },
    on: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    to: () => ({ emit: () => undefined }),
  } as unknown as Socket;

  async function invoke(event: string, input: unknown) {
    let result: unknown;
    await listeners.get(event)![0](input, (value) => {
      result = value;
    });
    return result;
  }

  async function disconnect() {
    await Promise.all(
      (listeners.get("disconnect") ?? []).map((listener) =>
        listener(undefined, () => undefined),
      ),
    );
  }

  return { socket, joined, left, emitted, invoke, disconnect };
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

test("keeps durable realtime connected when presence registration fails", async () => {
  const fake = fakeSocket();
  const controller = createSocketController(
    { getConversationAccess: async () => ({ status: "member" }) },
    {
      connected: async () => { throw new Error("redis unavailable"); },
      disconnected: async () => undefined,
      statuses: async () => ({}),
    },
  );

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

test("returns authorized conversation presence and manages the socket lease", async () => {
  const conversationId = randomUUID();
  const calls: unknown[] = [];
  const fake = fakeSocket();
  const controller = createSocketController(
    {
      getConversationAccess: async () => ({ status: "member" }),
      getConversationMemberIds: async (...args) => {
        calls.push(["members", ...args]);
        return { status: "found", memberIds: ["user-1", "user-2"] };
      },
    },
    {
      connected: async (...args) => {
        calls.push(["connected", ...args]);
      },
      disconnected: async (...args) => {
        calls.push(["disconnected", ...args]);
      },
      statuses: async (userIds) => Object.fromEntries(userIds.map((id) => [id, true])),
    },
  );
  await controller.connected(fake.socket);

  assert.deepEqual(await fake.invoke("presence.get", { conversationId: "invalid" }), {
    status: "invalid",
  });
  assert.deepEqual(await fake.invoke("presence.get", { conversationId }), {
    status: "ok",
    members: { "user-1": true, "user-2": true },
  });
  assert.deepEqual(calls.slice(0, 2), [
    ["connected", "user-1", "socket-1"],
    ["members", "user-1", conversationId],
  ]);
  await fake.disconnect();
  assert.deepEqual(calls.at(-1), ["disconnected", "user-1", "socket-1"]);
});

test("does not expose presence to a nonmember", async () => {
  const fake = fakeSocket();
  let queried = false;
  const controller = createSocketController(
    {
      getConversationAccess: async () => ({ status: "forbidden" }),
      getConversationMemberIds: async () => ({ status: "forbidden" }),
    },
    {
      connected: async () => undefined,
      disconnected: async () => undefined,
      statuses: async () => {
        queried = true;
        return {};
      },
    },
  );
  await controller.connected(fake.socket);

  assert.deepEqual(await fake.invoke("presence.get", { conversationId: randomUUID() }), {
    status: "forbidden",
  });
  assert.equal(queried, false);
});
