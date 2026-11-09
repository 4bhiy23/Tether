import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { DeviceSessionService } from "../device-sessions/device-session.service.js";
import { createReadStateController } from "./read-state.controller.js";
import type { ReadStateService } from "./read-state.service.js";

test("authenticates and validates mark-read commands", async () => {
  const conversationId = randomUUID();
  const calls: unknown[] = [];
  const reads = {
    markRead: async (...args: unknown[]) => {
      calls.push(args);
      return { status: "read", lastReadSequence: 4, advanced: true };
    },
  } as unknown as ReadStateService;
  const sessions = {
    getCurrent: async () => ({ user: { id: "alice" } }),
  } as unknown as DeviceSessionService;
  const app = new Hono();
  app.put("/api/conversations/:id/read", createReadStateController(reads, sessions).markRead);

  const response = await app.request(`/api/conversations/${conversationId}/read`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sequence: 4 }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { conversationId, lastReadSequence: 4 });
  assert.deepEqual(calls, [["alice", conversationId, 4]]);

  for (const [id, sequence] of [["invalid", 1], [conversationId, 0], [conversationId, 1.5]]) {
    assert.equal(
      (
        await app.request(`/api/conversations/${id}/read`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sequence }),
        })
      ).status,
      400,
    );
  }
  assert.equal(calls.length, 1);
});

test("maps mark-read authorization results", async () => {
  const conversationId = randomUUID();
  const sessions = {
    getCurrent: async () => ({ user: { id: "alice" } }),
  } as unknown as DeviceSessionService;
  for (const [status, expected] of [["not-found", 404], ["forbidden", 403], ["invalid-sequence", 400]] as const) {
    const app = new Hono();
    app.put(
      "/api/conversations/:id/read",
      createReadStateController({ markRead: async () => ({ status }) } as ReadStateService, sessions)
        .markRead,
    );
    assert.equal(
      (
        await app.request(`/api/conversations/${conversationId}/read`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sequence: 1 }),
        })
      ).status,
      expected,
    );
  }
});
