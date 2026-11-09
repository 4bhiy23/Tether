import type { Hono } from "hono";
import { createReadStateController } from "./read-state.controller.js";

export function registerReadStateRoutes(app: Hono) {
  app.put("/api/conversations/:id/read", createReadStateController().markRead);
}
