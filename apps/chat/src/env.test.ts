import assert from "node:assert/strict";
import test from "node:test";
import { readEnv } from "./env.js";

test("requires a strong Better Auth secret", () => {
  assert.throws(() => readEnv({ BETTER_AUTH_SECRET: "short" }), /at least 32/);
});

test("parses and validates environment values", () => {
  const source = {
    BETTER_AUTH_SECRET: "01234567890123456789012345678901",
    DATABASE_URL: "postgresql://localhost/tether",
    REDIS_URL: "redis://localhost:6379",
    CHAT_PORT: "4001",
  };

  assert.deepEqual(readEnv(source), {
    chatPort: 4001,
    databaseUrl: source.DATABASE_URL,
    redisUrl: source.REDIS_URL,
    webOrigin: "http://localhost:3000",
  });
  assert.throws(() => readEnv({ ...source, CHAT_PORT: "0" }));
  assert.throws(() => readEnv({ ...source, DATABASE_URL: "not a url" }));
  assert.throws(() => readEnv({ ...source, DATABASE_URL: "https://localhost/tether" }));
  assert.throws(() => readEnv({ ...source, REDIS_URL: "https://localhost:6379" }));
});
