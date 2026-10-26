import { serve } from "@hono/node-server";
import { auth, pool } from "./auth.js";
import { env } from "./env.js";
import { registerDeviceSessionRoutes } from "./routes/device-session.routes.js";
import { deviceSessionService } from "./services/device-session.service.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient } from "redis";
import { Server } from "socket.io";

const redis = createClient({ url: env.redisUrl });
redis.on("error", (error) => console.error("Redis error", error));
void redis.connect().catch(() => undefined);

const app = new Hono();
app.use("*", cors({ origin: env.webOrigin, credentials: true }));
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/health", async (c) => {
  try {
    await Promise.all([pool.query("select 1"), redis.ping()]);
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 503);
  }
});

const io = new Server({
  transports: ["websocket"],
  cors: {
    origin: env.webOrigin,
    credentials: true,
  },
});

io.use(async (socket, next) => {
  const session = await deviceSessionService.getCurrent(
    new Headers(socket.request.headers as HeadersInit),
  );
  if (!session) return next(new Error("unauthorized"));
  socket.data.sessionId = session.session.id;
  next();
});

io.on("connection", (socket) => {
  socket.join(`session:${socket.data.sessionId}`);
  socket.emit("chat.ready");
});

registerDeviceSessionRoutes(app, (sessionId) => {
  io.in(`session:${sessionId}`).disconnectSockets(true);
});

const httpServer = serve({
  fetch: app.fetch,
  port: env.chatPort,
});

io.attach(httpServer);
