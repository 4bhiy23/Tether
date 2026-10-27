import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { chatService, type ChatService } from "./chat.service.js";
import {
  deviceSessionService,
  type DeviceSessionService,
} from "../device-sessions/device-session.service.js";

const memberIds = z
  .array(z.string().min(1))
  .refine((ids) => new Set(ids).size === ids.length);
const title = z.string().trim().min(1).max(100).optional();
const createConversationBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct"), memberIds: memberIds.length(1), title }),
  z.object({ kind: z.literal("group"), memberIds: memberIds.min(2).max(49), title }),
]);
const sendMessageBody = z.object({
  clientMessageId: z.uuid(),
  content: z
    .string()
    .max(10_000)
    .refine((value) => value.trim().length > 0),
});

async function body<T>(c: Context, schema: z.ZodType<T>) {
  const result = schema.safeParse(await c.req.json().catch(() => null));
  if (!result.success) throw new HTTPException(400);
  return result.data;
}

export function createChatController(
  chats: ChatService = chatService,
  sessions: DeviceSessionService = deviceSessionService,
) {
  async function currentUserId(c: Context) {
    const session = await sessions.getCurrent(c.req.raw.headers);
    if (!session) throw new HTTPException(401);
    return session.user.id;
  }

  return {
    createConversation: async (c: Context) => {
      const userId = await currentUserId(c);
      const input = await body(c, createConversationBody);
      if (input.memberIds.includes(userId)) throw new HTTPException(400);

      const result = await chats.createConversation(userId, {
        kind: input.kind,
        memberIds: input.memberIds,
        ...(input.title ? { title: input.title } : {}),
      });
      if (result.status === "invalid-members") throw new HTTPException(400);
      return c.json(result.conversation, 201);
    },

    sendMessage: async (c: Context) => {
      const userId = await currentUserId(c);
      const conversationId = z.uuid().safeParse(c.req.param("id"));
      if (!conversationId.success) throw new HTTPException(400);
      const input = await body(c, sendMessageBody);

      const result = await chats.sendMessage(userId, conversationId.data, {
        clientMessageId: input.clientMessageId,
        content: input.content,
      });
      if (result.status === "not-found") throw new HTTPException(404);
      if (result.status === "forbidden") throw new HTTPException(403);
      if (result.status === "idempotency-conflict") throw new HTTPException(409);
      return c.json(result.message, result.replayed ? 200 : 201);
    },
  };
}
