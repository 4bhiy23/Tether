import type { Hono } from "hono";
import { createDeviceSessionController } from "./device-session.controller.js";

export function registerDeviceSessionRoutes(
  app: Hono,
  disconnectSession: (sessionId: string) => void,
) {
  const controller = createDeviceSessionController(disconnectSession);
  app.get("/api/session", controller.current);
  app.post("/api/sessions/:id/revoke", controller.revoke);
}
