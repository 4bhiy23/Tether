import type { Hono } from "hono";
import { createDirectoryController } from "./directory.controller.js";

export function registerDirectoryRoutes(app: Hono) {
  app.post("/api/users/lookup", createDirectoryController().lookup);
}
