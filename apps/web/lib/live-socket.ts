"use client";

import { io } from "socket.io-client";
import { chatUrl } from "./auth-client";
import { openChatStore } from "./chat-store";
import { createChatSyncCoordinator, startForegroundSync } from "./chat-sync";
import { createLiveEventConsumer } from "./live-events";

export async function connectLiveEvents(userId: string) {
  const abort = new AbortController();
  const store = await openChatStore(userId);
  const coordinator = createChatSyncCoordinator({
    baseUrl: chatUrl,
    store,
    signal: abort.signal,
  });
  const consumer = createLiveEventConsumer({
    onMessage: coordinator.roomMessage,
    onAccountEvent: coordinator.accountEvent,
  });
  const socket = io(chatUrl, {
    autoConnect: false,
    transports: ["websocket"],
    withCredentials: true,
  });
  const messageCreated = (input: unknown) => {
    void consumer.messageCreated(input).catch(() => console.error("Live message handling failed"));
  };
  const accountEvent = (input: unknown) => {
    void consumer.accountEvent(input).catch(() => console.error("Account event handling failed"));
  };
  const connected = () => {
    void coordinator.initialize().catch(() => console.error("Chat initialization failed"));
  };

  socket.on("message.created", messageCreated);
  socket.on("account.event", accountEvent);
  socket.on("connect", connected);
  socket.connect();

  const stopForegroundSync = startForegroundSync({ synchronize: coordinator.initialize });
  function close() {
    abort.abort();
    stopForegroundSync();
    socket.off("message.created", messageCreated);
    socket.off("account.event", accountEvent);
    socket.off("connect", connected);
    socket.disconnect();
    store.close();
  }

  void coordinator.initialize().catch(() => console.error("Chat initialization failed"));
  return { close };
}
