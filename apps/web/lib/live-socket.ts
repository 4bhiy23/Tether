"use client";

import { io } from "socket.io-client";
import { chatUrl } from "./auth-client";
import { createLiveEventConsumer } from "./live-events";

export type LiveMessage = {
  id: string;
  conversationId: string;
  sequence: number;
  senderId: string;
  clientMessageId: string;
  content: string;
  createdAt: string;
};

export type LiveAccountEvent = {
  id: string;
  userId: string;
  sequence: number;
  type: "message.created";
  conversationId: string;
  messageId: string;
  payload: LiveMessage;
  createdAt: string;
};

export function connectLiveEvents() {
  const messages = new Map<string, LiveMessage>();
  const accountEvents = new Map<string, LiveAccountEvent>();
  const consumer = createLiveEventConsumer<LiveMessage, LiveAccountEvent>({
    onMessage: (message) => messages.set(message.id, message),
    onAccountEvent: (event) => accountEvents.set(event.id, event),
  });
  const socket = io(chatUrl, {
    transports: ["websocket"],
    withCredentials: true,
  });

  socket.on("message.created", consumer.messageCreated);
  socket.on("account.event", consumer.accountEvent);

  return {
    messages,
    accountEvents,
    close() {
      socket.off("message.created", consumer.messageCreated);
      socket.off("account.event", consumer.accountEvent);
      socket.disconnect();
      messages.clear();
      accountEvents.clear();
    },
  };
}
