import type { Socket } from "socket.io";
import { z } from "zod";
import { chatService, type ChatService } from "../chat/chat.service.js";
import { presenceService, type PresenceService } from "../presence/presence.service.js";
import { registerTypingHandlers } from "./typing.js";

const conversationInput = z.object({ conversationId: z.uuid() });
type MemberIdsResult =
  | { status: "found"; memberIds: string[] }
  | { status: "not-found" | "forbidden" };
type MembershipService = Pick<ChatService, "getConversationAccess"> & {
  getConversationMemberIds?: (userId: string, conversationId: string) => Promise<MemberIdsResult>;
};
type Presence = Pick<PresenceService, "connected" | "disconnected" | "statuses">;

function acknowledge(callback: unknown, result: unknown) {
  if (typeof callback === "function") (callback as (value: unknown) => void)(result);
}

const disabledPresence: Presence = {
  connected: async () => undefined,
  disconnected: async () => undefined,
  statuses: async () => ({}),
};

export function createSocketController(
  chats: MembershipService = chatService,
  presence: Presence = disabledPresence,
) {
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

      socket.on("presence.get", async (input: unknown, callback: unknown) => {
        const parsed = conversationInput.safeParse(input);
        if (!parsed.success) return acknowledge(callback, { status: "invalid" });
        if (!chats.getConversationMemberIds) {
          return acknowledge(callback, { status: "unavailable" });
        }

        try {
          const result = await chats.getConversationMemberIds(
            socket.data.userId,
            parsed.data.conversationId,
          );
          if (result.status !== "found") return acknowledge(callback, result);
          acknowledge(callback, {
            status: "ok",
            members: await presence.statuses(result.memberIds),
          });
        } catch {
          acknowledge(callback, { status: "unavailable" });
        }
      });

      registerTypingHandlers(socket);
      const presenceRegistration = presence
        .connected(socket.data.userId, socket.id)
        .catch(() => undefined);
      socket.on("disconnect", () => {
        void presenceRegistration.then(() =>
          presence.disconnected(socket.data.userId, socket.id).catch(() => undefined),
        );
      });

      await socket.join([
        `session:${socket.data.sessionId}`,
        `user:${socket.data.userId}`,
      ]);
      socket.emit("chat.ready");
    },
  };
}

export const socketController = createSocketController(
  chatService,
  presenceService,
);
