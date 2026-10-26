import assert from "node:assert/strict";
import test from "node:test";
import { readEnv } from "./env.js";

test("requires a strong Better Auth secret", () => {
  assert.throws(() => readEnv({ BETTER_AUTH_SECRET: "short" }), /at least 32/);
});
