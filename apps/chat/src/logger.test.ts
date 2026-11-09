import assert from "node:assert/strict";
import test from "node:test";
import type { DestinationStream } from "pino";
import { createLogger } from "./logger.js";

test("writes structured logs with service and instance identity", () => {
  const lines: string[] = [];
  const destination = {
    write(value: string) {
      lines.push(value);
    },
  } as DestinationStream;
  const log = createLogger("chat-2", "info", destination);

  log.info({ requestId: "request-1" }, "request completed");

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(entry.service, "tether-chat");
  assert.equal(entry.instanceId, "chat-2");
  assert.equal(entry.requestId, "request-1");
  assert.equal(entry.msg, "request completed");
});
