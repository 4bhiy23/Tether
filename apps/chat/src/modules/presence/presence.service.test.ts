import assert from "node:assert/strict";
import test from "node:test";
import { createPresenceService } from "./presence.service.js";

function fakeRedis() {
  const sets = new Map<string, Map<string, number>>();
  let connected = 0;
  let quit = 0;
  const values = (key: string) => {
    const existing = sets.get(key) ?? new Map<string, number>();
    sets.set(key, existing);
    return existing;
  };

  return {
    client: {
      on: () => undefined,
      connect: async () => {
        connected += 1;
      },
      quit: async () => {
        quit += 1;
        return "OK";
      },
      expire: async () => true,
      zAdd: async (key: string, entries: Array<{ score: number; value: string }>) => {
        for (const entry of entries) values(key).set(entry.value, entry.score);
        return entries.length;
      },
      zRem: async (key: string, member: string) => (values(key).delete(member) ? 1 : 0),
      zRemRangeByScore: async (key: string, _minimum: string, maximum: number) => {
        let removed = 0;
        for (const [member, score] of values(key)) {
          if (score <= maximum) {
            values(key).delete(member);
            removed += 1;
          }
        }
        return removed;
      },
      zCount: async (key: string, minimum: number, _maximum: string) =>
        [...values(key).values()].filter((score) => score >= minimum).length,
    },
    counts: () => ({ connected, quit }),
  };
}

test("tracks independent socket leases and expires crashed sockets", async () => {
  let now = 1_000;
  const redis = fakeRedis();
  const service = createPresenceService(redis.client as never, {
    now: () => now,
    setInterval: (() => 1) as never,
    clearInterval: (() => undefined) as never,
  });
  await service.start();
  await service.connected("alice", "socket-a");
  await service.connected("alice", "socket-b");

  assert.deepEqual(await service.statuses(["alice", "bob", "alice"]), {
    alice: true,
    bob: false,
  });

  await service.disconnected("alice", "socket-a");
  assert.equal((await service.statuses(["alice"])).alice, true);

  now += 30_001;
  assert.equal((await service.statuses(["alice"])).alice, false);
  await service.close();
  assert.deepEqual(redis.counts(), { connected: 1, quit: 1 });
});

test("refresh extends only locally owned socket leases", async () => {
  let now = 5_000;
  const redis = fakeRedis();
  const first = createPresenceService(redis.client as never, { now: () => now });
  const second = createPresenceService(redis.client as never, { now: () => now });
  await first.connected("alice", "first");
  await second.connected("alice", "second");

  now += 20_000;
  await first.refresh();
  now += 10_001;

  assert.equal((await first.statuses(["alice"])).alice, true);
  await first.disconnected("alice", "first");
  assert.equal((await first.statuses(["alice"])).alice, false);
});
