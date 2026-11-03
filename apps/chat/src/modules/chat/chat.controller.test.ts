import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import { createChatController } from "./chat.controller.js";
import type { ChatService } from "./chat.service.js";
import type { DeviceSessionService } from "../device-sessions/device-session.service.js";

test("validates chat inputs before calling services", async () => {
  const userId = randomUUID();
  const calls: unknown[] = [];
  const chats = {
    createConversation: async (...args: unknown[]) => {
      calls.push(args);
      return { status: "created", conversation: {} };
    },
    sendMessage: async (...args: unknown[]) => {
      calls.push(args);
      return { status: "sent", message: {}, replayed: false };
    },
    listMessages: async (...args: unknown[]) => {
      calls.push(args);
      return { status: "found", messages: [], nextBeforeSequence: null, hasMore: false };
    },
  } as unknown as ChatService;
  const sessions = {
    getCurrent: async () => ({ user: { id: userId } }),
  } as unknown as DeviceSessionService;
  const controller = createChatController(chats, sessions);
  const app = new Hono();
  app.post("/api/conversations", controller.createConversation);
  app.post("/api/conversations/:id/messages", controller.sendMessage);
  app.get("/api/conversations/:id/messages", controller.listMessages);

  const duplicateMembers = await app.request("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "group", memberIds: ["bob", "bob"] }),
  });
  const invalidMessage = await app.request("/api/conversations/not-a-uuid/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientMessageId: randomUUID(), content: "hello" }),
  });
  const invalidHistory = await app.request(
    `/api/conversations/${randomUUID()}/messages?beforeSequence=0&limit=101`,
  );

  assert.equal(duplicateMembers.status, 400);
  assert.equal(invalidMessage.status, 400);
  assert.equal(invalidHistory.status, 400);
  assert.deepEqual(calls, []);
});

test("normalizes titles without changing message content", async () => {
  const userId = randomUUID();
  const memberId = randomUUID();
  const calls: unknown[] = [];
  const chats = {
    createConversation: async (...args: unknown[]) => {
      calls.push(args);
      return { status: "created", conversation: {} };
    },
    sendMessage: async (...args: unknown[]) => {
      calls.push(args);
      return { status: "sent", message: {}, replayed: false };
    },
    listMessages: async (...args: unknown[]) => {
      calls.push(args);
      return { status: "found", messages: [], nextBeforeSequence: null, hasMore: false };
    },
  } as unknown as ChatService;
  const sessions = {
    getCurrent: async () => ({ user: { id: userId } }),
  } as unknown as DeviceSessionService;
  const controller = createChatController(chats, sessions);
  const app = new Hono();
  app.post("/api/conversations", controller.createConversation);
  app.post("/api/conversations/:id/messages", controller.sendMessage);
  const conversationId = randomUUID();
  const clientMessageId = randomUUID();

  assert.equal(
    (
      await app.request("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "direct", memberIds: [memberId], title: "  Friends  " }),
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await app.request(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientMessageId, content: "  hello  " }),
      })
    ).status,
    201,
  );

  assert.deepEqual(calls[0], [
    userId,
    { kind: "direct", memberIds: [memberId], title: "Friends" },
  ]);
  assert.deepEqual(calls[1], [
    userId,
    conversationId,
    { clientMessageId, content: "  hello  " },
  ]);
});

test("authenticates and maps message history results", async () => {
  const userId = randomUUID();
  const conversationId = randomUUID();
  const calls: unknown[] = [];
  let status: "found" | "forbidden" | "not-found" = "found";
  const chats = {
    listMessages: async (...args: unknown[]) => {
      calls.push(args);
      if (status !== "found") return { status };
      return { status, messages: [{ id: "message" }], nextBeforeSequence: 3, hasMore: true };
    },
  } as unknown as ChatService;
  const sessions = {
    getCurrent: async () => ({ user: { id: userId } }),
  } as unknown as DeviceSessionService;
  const controller = createChatController(chats, sessions);
  const app = new Hono();
  app.get("/api/conversations/:id/messages", controller.listMessages);

  const response = await app.request(
    `/api/conversations/${conversationId}/messages?beforeSequence=5&limit=2`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    messages: [{ id: "message" }],
    nextBeforeSequence: 3,
    hasMore: true,
  });
  assert.deepEqual(calls, [[userId, conversationId, { beforeSequence: 5, limit: 2 }]]);

  status = "forbidden";
  assert.equal((await app.request(`/api/conversations/${conversationId}/messages`)).status, 403);
  status = "not-found";
  assert.equal((await app.request(`/api/conversations/${conversationId}/messages`)).status, 404);

  const unauthenticated = createChatController(
    chats,
    { getCurrent: async () => null } as unknown as DeviceSessionService,
  );
  const protectedApp = new Hono();
  protectedApp.get("/api/conversations/:id/messages", unauthenticated.listMessages);
  assert.equal(
    (await protectedApp.request(`/api/conversations/${conversationId}/messages`)).status,
    401,
  );
});
