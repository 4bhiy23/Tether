import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { DeviceSessionService } from "../device-sessions/device-session.service.js";
import { createSyncController } from "./sync.controller.js";
import type { SyncService } from "./sync.service.js";

test("authenticates and validates snapshot and event sync requests", async () => {
  const userId = randomUUID();
  const calls: unknown[] = [];
  const sync = {
    getSnapshot: async (...args: unknown[]) => {
      calls.push(["snapshot", ...args]);
      return { mode: "snapshot", conversations: [], nextToken: 0, resetRequired: false };
    },
    getEvents: async (...args: unknown[]) => {
      calls.push(["events", ...args]);
      return {
        mode: "events",
        events: [],
        nextToken: 0,
        hasMore: false,
        resetRequired: false,
      };
    },
  } as unknown as SyncService;
  const sessions = {
    getCurrent: async () => ({ user: { id: userId } }),
  } as unknown as DeviceSessionService;
  const controller = createSyncController(sync, sessions);
  const app = new Hono();
  app.get("/api/sync", controller.get);

  assert.equal((await app.request("/api/sync")).status, 200);
  assert.equal((await app.request("/api/sync?after=0&limit=25")).status, 200);
  assert.deepEqual(calls, [
    ["snapshot", userId],
    ["events", userId, 0, 25],
  ]);

  for (const query of [
    "limit=10",
    "after=",
    "after=-1",
    "after=1.5",
    `after=${Number.MAX_SAFE_INTEGER + 1}`,
    "after=0&limit=0",
    "after=0&limit=101",
  ]) {
    assert.equal((await app.request(`/api/sync?${query}`)).status, 400);
  }
  assert.equal(calls.length, 2);
});

test("rejects sync without a session", async () => {
  const sync = {} as SyncService;
  const sessions = {
    getCurrent: async () => null,
  } as unknown as DeviceSessionService;
  const controller = createSyncController(sync, sessions);
  const app = new Hono();
  app.get("/api/sync", controller.get);

  assert.equal((await app.request("/api/sync?after=0")).status, 401);
});
