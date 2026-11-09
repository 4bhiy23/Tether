import type { Socket } from "socket.io";
import { z } from "zod";

const typingInput = z.object({ conversationId: z.uuid() });
const startIntervalMs = 1_000;

type Acknowledge = (result: {
  status: "sent" | "invalid" | "forbidden" | "rate-limited";
}) => void;

function acknowledge(callback: unknown, status: Parameters<Acknowledge>[0]["status"]) {
  if (typeof callback === "function") (callback as Acknowledge)({ status });
}

export function registerTypingHandlers(socket: Socket, now: () => number = Date.now) {
  const lastStartedAt = new Map<string, number>();

  socket.on("typing.start", (input: unknown, callback: unknown) => {
    const parsed = typingInput.safeParse(input);
    if (!parsed.success) return acknowledge(callback, "invalid");
    const room = `conversation:${parsed.data.conversationId}`;
    if (!socket.rooms.has(room)) return acknowledge(callback, "forbidden");

    const last = lastStartedAt.get(parsed.data.conversationId);
    const at = now();
    if (last !== undefined && at - last < startIntervalMs) {
      return acknowledge(callback, "rate-limited");
    }
    lastStartedAt.set(parsed.data.conversationId, at);
    socket.to(room).emit("typing.changed", {
      conversationId: parsed.data.conversationId,
      userId: socket.data.userId,
      isTyping: true,
    });
    acknowledge(callback, "sent");
  });

  socket.on("typing.stop", (input: unknown, callback: unknown) => {
    const parsed = typingInput.safeParse(input);
    if (!parsed.success) return acknowledge(callback, "invalid");
    const room = `conversation:${parsed.data.conversationId}`;
    if (!socket.rooms.has(room)) return acknowledge(callback, "forbidden");

    socket.to(room).emit("typing.changed", {
      conversationId: parsed.data.conversationId,
      userId: socket.data.userId,
      isTyping: false,
    });
    acknowledge(callback, "sent");
  });

  socket.on("disconnect", () => lastStartedAt.clear());
}
