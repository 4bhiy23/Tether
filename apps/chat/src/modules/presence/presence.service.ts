import { createClient } from "redis";
import { env } from "../../env.js";
import { logger } from "../../logger.js";

const leaseMs = 30_000;
const refreshMs = 10_000;
const keyTtlSeconds = 60;

type RedisClient = Pick<
  ReturnType<typeof createClient>,
  "connect" | "expire" | "on" | "quit" | "zAdd" | "zCount" | "zRem" | "zRemRangeByScore"
>;

const key = (userId: string) => `tether:presence:${userId}`;

export function createPresenceService(
  redis: RedisClient = createClient({ url: env.redisUrl }),
  options: {
    now?: () => number;
    onError?: (error: unknown) => void;
    setInterval?: typeof globalThis.setInterval;
    clearInterval?: typeof globalThis.clearInterval;
  } = {},
) {
  const now = options.now ?? Date.now;
  const setInterval = options.setInterval ?? globalThis.setInterval;
  const clearInterval = options.clearInterval ?? globalThis.clearInterval;
  const onError = options.onError ?? ((error) => logger.error({ err: error }, "Redis presence error"));
  const localSockets = new Map<string, string>();
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;
  let started = false;

  redis.on("error", onError);

  async function renew(userId: string, socketId: string) {
    const presenceKey = key(userId);
    await redis.zAdd(presenceKey, [{ score: now() + leaseMs, value: socketId }]);
    await redis.expire(presenceKey, keyTtlSeconds);
  }

  async function refresh() {
    await Promise.all(
      [...localSockets].map(([socketId, userId]) => renew(userId, socketId)),
    );
  }

  return {
    async start() {
      if (started) return;
      await redis.connect();
      started = true;
      timer = setInterval(() => void refresh().catch(onError), refreshMs);
    },

    async connected(userId: string, socketId: string) {
      await renew(userId, socketId);
      localSockets.set(socketId, userId);
    },

    async disconnected(userId: string, socketId: string) {
      localSockets.delete(socketId);
      await redis.zRem(key(userId), socketId);
    },

    refresh,

    async statuses(userIds: string[]) {
      const at = now();
      return Object.fromEntries(
        await Promise.all(
          [...new Set(userIds)].map(async (userId) => {
            const presenceKey = key(userId);
            await redis.zRemRangeByScore(presenceKey, "-inf", at);
            return [userId, (await redis.zCount(presenceKey, at + 1, "+inf")) > 0] as const;
          }),
        ),
      );
    },

    async close() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      const sockets = [...localSockets];
      localSockets.clear();
      await Promise.allSettled(
        sockets.map(([socketId, userId]) => redis.zRem(key(userId), socketId)),
      );
      if (started) await redis.quit();
      started = false;
    },
  };
}

export const presenceService = createPresenceService();
export type PresenceService = typeof presenceService;
