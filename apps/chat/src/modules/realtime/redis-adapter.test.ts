import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient as createRedisClient } from "redis";
import { Server } from "socket.io";
import { io as createSocketClient, type Socket as ClientSocket } from "socket.io-client";

function nextEvent(socket: ClientSocket, event: string) {
  return new Promise<unknown[]>((resolve) => socket.once(event, (...args) => resolve(args)));
}

test("delivers room events between Socket.IO server instances", { timeout: 10_000 }, async () => {
  const redisUrl = process.env.REDIS_URL!;
  const key = `tether-test-${randomUUID()}`;
  const httpServers = [createServer(), createServer()];
  const ioServers = httpServers.map(
    (server) => new Server(server, { transports: ["websocket"] }),
  );
  const redisClients = Array.from({ length: 4 }, () => createRedisClient({ url: redisUrl }));
  for (const client of redisClients) client.on("error", () => undefined);

  try {
    await Promise.all(redisClients.map((client) => client.connect()));
    ioServers[0].adapter(createAdapter(redisClients[0], redisClients[1], { key }));
    ioServers[1].adapter(createAdapter(redisClients[2], redisClients[3], { key }));

    await Promise.all(
      httpServers.map(
        (server) =>
          new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      ),
    );
    const address = httpServers[1].address();
    assert.ok(address && typeof address !== "string");

    ioServers[1].on("connection", async (socket) => {
      await socket.join("conversation:test");
      socket.emit("joined");
    });
    const socket = createSocketClient(`http://127.0.0.1:${address.port}`, {
      autoConnect: false,
      reconnection: false,
      transports: ["websocket"],
    });
    const joined = nextEvent(socket, "joined");
    socket.connect();
    await joined;

    const received = nextEvent(socket, "message.created");
    ioServers[0].to("conversation:test").emit("message.created", { id: "message-1" });
    assert.deepEqual(await received, [{ id: "message-1" }]);
    socket.disconnect();
  } finally {
    await Promise.all(
      ioServers.map(
        (io) => new Promise<void>((resolve) => io.close(() => resolve())),
      ),
    );
    await Promise.allSettled(redisClients.map((client) => client.quit()));
  }
});
