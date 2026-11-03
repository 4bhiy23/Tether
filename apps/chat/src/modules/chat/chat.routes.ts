import type { Hono } from "hono";
import { createChatController } from "./chat.controller.js";

export function registerChatRoutes(app: Hono) {
  const controller = createChatController();
  app.post("/api/conversations", controller.createConversation);
  app.post("/api/conversations/:id/messages", controller.sendMessage);
  app.get("/api/conversations/:id/messages", controller.listMessages);
}
