import type { Socket } from "socket.io";
import { z } from "zod";
import { chatService, type ChatService } from "../chat/chat.service.js";

const conversationInput = z.object({ conversationId: z.uuid() });
type MembershipService = Pick<ChatService, "getConversationAccess">;
type Acknowledgement = {
  status: "joined" | "left" | "invalid" | "not-found" | "forbidden" | "unavailable";
};
type Acknowledge = (result: Acknowledgement) => void;

function acknowledge(callback: unknown, result: Acknowledgement) {
  if (typeof callback === "function") (callback as Acknowledge)(result);
}

export function createSocketController(chats: MembershipService = chatService) {
  return {
    async connected(socket: Socket) {
      socket.on("conversation.join", async (input: unknown, callback: unknown) => {
        const parsed = conversationInput.safeParse(input);
        if (!parsed.success) return acknowledge(callback, { status: "invalid" });

        try {
          const access = await chats.getConversationAccess(
            socket.data.userId,
            parsed.data.conversationId,
          );
          if (access.status !== "member") return acknowledge(callback, access);

          await socket.join(`conversation:${parsed.data.conversationId}`);
          acknowledge(callback, { status: "joined" });
        } catch {
          acknowledge(callback, { status: "unavailable" });
        }
      });

      socket.on("conversation.leave", async (input: unknown, callback: unknown) => {
        const parsed = conversationInput.safeParse(input);
        if (!parsed.success) return acknowledge(callback, { status: "invalid" });

        await socket.leave(`conversation:${parsed.data.conversationId}`);
        acknowledge(callback, { status: "left" });
      });

      await socket.join([
        `session:${socket.data.sessionId}`,
        `user:${socket.data.userId}`,
      ]);
      socket.emit("chat.ready");
    },
  };
}

export const socketController = createSocketController();
