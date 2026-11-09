import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createRequestLogger } from "./request-logger.js";

test("logs completed HTTP requests without headers or bodies", async () => {
  const entries: Array<{ level: string; values: Record<string, unknown>; message: string }> = [];
  const log = {
    info(values: Record<string, unknown>, message: string) {
      entries.push({ level: "info", values, message });
    },
    error(values: Record<string, unknown>, message: string) {
      entries.push({ level: "error", values, message });
    },
  };
  const times = [10, 12.345];
  const app = new Hono();
  app.use("*", createRequestLogger(log as never, () => times.shift()!));
  app.post("/messages", (context) => context.json({ ok: true }, 201));

  const response = await app.request("/messages?token=secret", {
    method: "POST",
    headers: { authorization: "Bearer secret", cookie: "session=secret" },
    body: JSON.stringify({ content: "private message" }),
  });

  assert.equal(response.status, 201);
  assert.match(response.headers.get("x-request-id")!, /^[0-9a-f-]{36}$/);
  assert.equal(entries.length, 1);
  assert.deepEqual(
    { ...entries[0], values: { ...entries[0].values, requestId: "request-id" } },
    {
      level: "info",
      values: {
        requestId: "request-id",
        method: "POST",
        path: "/messages",
        status: 201,
        durationMs: 2.35,
      },
      message: "HTTP request completed",
    },
  );
  assert.doesNotMatch(JSON.stringify(entries), /secret|private message/);
});
