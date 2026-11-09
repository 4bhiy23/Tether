import assert from "node:assert/strict";
import test from "node:test";
import { runOutboxPublisher } from "./outbox.publisher.js";

test("reports non-empty published batches", async () => {
  const completed: number[] = [];
  const abort = new AbortController();

  await runOutboxPublisher(
    async () => {
      abort.abort();
      return 2;
    },
    abort.signal,
    { onBatch: (count) => completed.push(count) },
  );

  assert.deepEqual(completed, [2]);
});
