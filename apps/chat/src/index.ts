import { serve } from "@hono/node-server";
import { auth } from "./auth.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { registerChatRoutes } from "./modules/chat/chat.routes.js";
import { registerDeviceSessionRoutes } from "./modules/device-sessions/device-session.routes.js";
import { deviceSessionService } from "./modules/device-sessions/device-session.service.js";
import { registerDirectoryRoutes } from "./modules/directory/directory.routes.js";
import { startOutboxPublisher } from "./modules/outbox/outbox.publisher.js";
import { presenceService } from "./modules/presence/presence.service.js";
import { registerReadStateRoutes } from "./modules/read-state/read-state.routes.js";
import { createRealtime } from "./modules/realtime/realtime.js";
import { socketController } from "./modules/realtime/socket.controller.js";
import { registerSyncRoutes } from "./modules/sync/sync.routes.js";
import { createRequestLogger } from "./request-logger.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Server } from "socket.io";

const app = new Hono();
app.use("*", createRequestLogger());
app.use("*", cors({ origin: env.webOrigin, credentials: true }));
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

const io = new Server({
  transports: ["websocket"],
  cors: {
    origin: env.webOrigin,
    credentials: true,
  },
});
const realtime = createRealtime(io, env.redisUrl, (source, error) => {
  logger.error({ err: error, source }, "Realtime error");
});

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
    if (!session) {
      logger.warn({ socketId: socket.id }, "WebSocket authentication rejected");
      return next(new Error("unauthorized"));
    }
    socket.data.sessionId = session.session.id;
    socket.data.userId = session.user.id;
    next();
  } catch (error) {
    logger.error({ err: error, socketId: socket.id }, "WebSocket authentication failed");
    next(new Error("authentication unavailable"));
  }
});

io.on("connection", (socket) => {
  const socketLog = logger.child({ socketId: socket.id, userId: socket.data.userId });
  socketLog.info("WebSocket connected");
  socket.onAny((event) => socketLog.info({ direction: "inbound", event }, "WebSocket event"));
  socket.onAnyOutgoing((event) =>
    socketLog.info({ direction: "outbound", event }, "WebSocket event"),
  );
  socket.once("disconnect", (reason) => socketLog.info({ reason }, "WebSocket disconnected"));
  void socketController.connected(socket).catch(() => socket.disconnect(true));
});

registerDeviceSessionRoutes(app, (sessionId) => {
  io.in(`session:${sessionId}`).disconnectSockets(true);
});
registerChatRoutes(app);
registerDirectoryRoutes(app);
registerReadStateRoutes(app);
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
      logger.info("Chat server stopping");
      abortPublisher.abort();
      await publisher?.catch(() => undefined);
      await Promise.allSettled([io.close()]);
      if (httpServer?.listening) {
        await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
      }
      await Promise.allSettled([presenceService.close(), realtime.close(), pool.end()]);
      logger.info("Chat server stopped");
    })();

    return stopping;
  }

  try {
    await Promise.all([realtime.start(), presenceService.start()]);

    publisher = startOutboxPublisher({
      publish: (channel, payload) => realtime.publish(channel, payload),
      signal: abortPublisher.signal,
      onBatch: (count) => logger.info({ count }, "Outbox batch published"),
      onError: (error) => logger.error({ err: error }, "Outbox publisher error"),
    });
    logger.info({ workers: ["outbox", "presence"] }, "Chat workers started");

    httpServer = serve({
      fetch: app.fetch,
      port: env.chatPort,
    });
    logger.info({ port: env.chatPort }, "Chat server started");
    httpServer.once("error", (error) => {
      logger.error({ err: error }, "Chat server failed");
      void stop(1);
    });
    io.attach(httpServer);

    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  } catch (error) {
    logger.fatal({ err: error }, "Chat startup failed");
    await stop(1);
  }
}

void start();
