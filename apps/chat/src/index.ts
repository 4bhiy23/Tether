import { serve } from "@hono/node-server";
import { auth } from "./auth.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import { registerChatRoutes } from "./modules/chat/chat.routes.js";
import { registerDeviceSessionRoutes } from "./modules/device-sessions/device-session.routes.js";
import { deviceSessionService } from "./modules/device-sessions/device-session.service.js";
import { startOutboxPublisher } from "./modules/outbox/outbox.publisher.js";
import { createRealtime } from "./modules/realtime/realtime.js";
import { socketController } from "./modules/realtime/socket.controller.js";
import { registerSyncRoutes } from "./modules/sync/sync.routes.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Server } from "socket.io";

const app = new Hono();
app.use("*", cors({ origin: env.webOrigin, credentials: true }));
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

const io = new Server({
  transports: ["websocket"],
  cors: {
    origin: env.webOrigin,
    credentials: true,
  },
});
const realtime = createRealtime(io, env.redisUrl);

app.get("/health", async (c) => {
  try {
    await Promise.all([pool.query("select 1"), realtime.ping()]);
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 503);
  }
});

io.use(async (socket, next) => {
  try {
    const session = await deviceSessionService.getCurrent(
      new Headers(socket.request.headers as HeadersInit),
    );
    if (!session) return next(new Error("unauthorized"));
    socket.data.sessionId = session.session.id;
    socket.data.userId = session.user.id;
    next();
  } catch {
    next(new Error("authentication unavailable"));
  }
});

io.on("connection", (socket) => {
  void socketController.connected(socket).catch(() => socket.disconnect(true));
});

registerDeviceSessionRoutes(app, (sessionId) => {
  io.in(`session:${sessionId}`).disconnectSockets(true);
});
registerChatRoutes(app);
registerSyncRoutes(app);

async function start() {
  const abortPublisher = new AbortController();
  let publisher: Promise<void> | undefined;
  let httpServer: ReturnType<typeof serve> | undefined;
  let stopping: Promise<void> | undefined;

  function stop(exitCode?: number) {
    if (exitCode !== undefined) process.exitCode = exitCode;
    if (stopping) return stopping;

    stopping = (async () => {
      abortPublisher.abort();
      await publisher?.catch(() => undefined);
      await Promise.allSettled([io.close()]);
      if (httpServer?.listening) {
        await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
      }
      await Promise.allSettled([realtime.close(), pool.end()]);
    })();

    return stopping;
  }

  try {
    await realtime.start();

    publisher = startOutboxPublisher({
      publish: (channel, payload) => realtime.publish(channel, payload),
      signal: abortPublisher.signal,
      onError: () => console.error("Outbox publisher error"),
    });

    httpServer = serve({
      fetch: app.fetch,
      port: env.chatPort,
    });
    httpServer.once("error", () => {
      console.error("Chat server failed");
      void stop(1);
    });
    io.attach(httpServer);

    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  } catch {
    console.error("Chat startup failed");
    await stop(1);
  }
}

void start();
