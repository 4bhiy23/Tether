import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { DeviceSessionService } from "../device-sessions/device-session.service.js";
import { createDirectoryController } from "./directory.controller.js";
import type { DirectoryService } from "./directory.service.js";

test("authenticates and normalizes exact email lookup", async () => {
  const calls: string[] = [];
  const directory = {
    findByEmail: async (email: string) => {
      calls.push(email);
      return email === "bob@example.com" ? { id: "bob", name: "Bob", email } : null;
    },
  } as DirectoryService;
  const sessions = {
    getCurrent: async () => ({ user: { id: "alice" } }),
  } as unknown as DeviceSessionService;
  const app = new Hono();
  app.post("/api/users/lookup", createDirectoryController(directory, sessions).lookup);

  const found = await app.request("/api/users/lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "  BOB@EXAMPLE.COM " }),
  });
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), { id: "bob", name: "Bob", email: "bob@example.com" });

  for (const email of ["bob", "bo@example.com", "bob@example.com.extra"]) {
    assert.equal(
      (
        await app.request("/api/users/lookup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        })
      ).status,
      email === "bob" ? 400 : 404,
    );
  }
  assert.deepEqual(calls, ["bob@example.com", "bo@example.com", "bob@example.com.extra"]);
});

test("rejects unauthenticated lookup", async () => {
  const app = new Hono();
  app.post(
    "/api/users/lookup",
    createDirectoryController({} as DirectoryService, {
      getCurrent: async () => null,
    } as unknown as DeviceSessionService).lookup,
  );
  assert.equal((await app.request("/api/users/lookup", { method: "POST" })).status, 401);
});
