import type { Hono } from "hono";
import { createSyncController } from "./sync.controller.js";

export function registerSyncRoutes(app: Hono) {
  const controller = createSyncController();
  app.get("/api/sync", controller.get);
}
