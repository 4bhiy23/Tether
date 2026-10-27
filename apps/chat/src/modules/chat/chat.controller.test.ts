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
  } as unknown as ChatService;
  const sessions = {
    getCurrent: async () => ({ user: { id: userId } }),
  } as unknown as DeviceSessionService;
  const controller = createChatController(chats, sessions);
  const app = new Hono();
  app.post("/api/conversations", controller.createConversation);
  app.post("/api/conversations/:id/messages", controller.sendMessage);

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

  assert.equal(duplicateMembers.status, 400);
  assert.equal(invalidMessage.status, 400);
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
