"use client";

import { io, type Socket } from "socket.io-client";
import { chatUrl } from "./auth-client";
import { openChatStore, type ChatStore } from "./chat-store";
import { createChatSyncCoordinator, startForegroundSync } from "./chat-sync";
import {
  conversationSchema,
  directoryUserSchema,
  markReadResponseSchema,
  messageSchema,
  presenceResponseSchema,
  typingChangedSchema,
  type Conversation,
  type DirectoryUser,
  type OptimisticMessage,
  type TypingChanged,
} from "./chat-types";
import { createLiveEventConsumer } from "./live-events";

type Request = (input: string, init?: RequestInit) => Promise<Response>;
type Timers = Pick<Window, "setInterval" | "clearInterval" | "setTimeout" | "clearTimeout">;

export function rejoinActiveConversation(
  socket: { emit(event: string, payload: unknown): unknown },
  conversationId?: string,
) {
  if (conversationId) socket.emit("conversation.join", { conversationId });
}

async function json(response: Response) {
  if (!response.ok) throw new Error(`Chat request failed with ${response.status}`);
  return response.json();
}

export function createReadCoordinator({
  current,
  update,
  confirmed,
}: {
  current: (conversationId: string) => Promise<number>;
  update: (conversationId: string, sequence: number) => Promise<number>;
  confirmed: (conversationId: string, sequence: number) => void | Promise<void>;
}) {
  const desired = new Map<string, number>();
  const active = new Map<string, Promise<void>>();

  function flush(conversationId: string) {
    const running = active.get(conversationId);
    if (running) return running;
    const promise = (async () => {
      while (desired.has(conversationId)) {
        const sequence = desired.get(conversationId)!;
        if (sequence <= await current(conversationId)) {
          if (desired.get(conversationId) === sequence) desired.delete(conversationId);
          continue;
        }
        try {
          const stored = await update(conversationId, sequence);
          await confirmed(conversationId, stored);
          if (desired.get(conversationId) === sequence) desired.delete(conversationId);
        } catch {
          break;
        }
      }
    })().finally(() => active.delete(conversationId));
    active.set(conversationId, promise);
    return promise;
  }

  return {
    async propose(conversationId: string, sequence: number) {
      if (sequence <= await current(conversationId)) return;
      desired.set(conversationId, Math.max(sequence, desired.get(conversationId) ?? 0));
      return flush(conversationId);
    },
    retry() {
      return Promise.all([...desired.keys()].map(flush));
    },
  };
}

export function createTypingTracker({
  onChange,
  timers = window,
  expiryMs = 5_000,
}: {
  onChange: () => void;
  timers?: Pick<Window, "setTimeout" | "clearTimeout">;
  expiryMs?: number;
}) {
  const users = new Map<string, Map<string, number>>();

  function remove(conversationId: string, userId: string) {
    const conversation = users.get(conversationId);
    const timeout = conversation?.get(userId);
    if (timeout !== undefined) timers.clearTimeout(timeout);
    conversation?.delete(userId);
    if (conversation?.size === 0) users.delete(conversationId);
    onChange();
  }

  return {
    apply(event: TypingChanged) {
      if (!event.isTyping) return remove(event.conversationId, event.userId);
      let conversation = users.get(event.conversationId);
      if (!conversation) {
        conversation = new Map();
        users.set(event.conversationId, conversation);
      }
      const current = conversation.get(event.userId);
      if (current !== undefined) timers.clearTimeout(current);
      conversation.set(
        event.userId,
        timers.setTimeout(() => remove(event.conversationId, event.userId), expiryMs),
      );
      onChange();
    },
    get(conversationId: string) { return [...(users.get(conversationId)?.keys() ?? [])]; },
    clear() {
      for (const [conversationId, conversation] of users) {
        for (const userId of conversation.keys()) remove(conversationId, userId);
      }
    },
  };
}

export function createOptimisticQueue({
  senderId,
  deliver,
  onChange,
  createId = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
}: {
  senderId: string;
  deliver: (message: OptimisticMessage) => Promise<unknown>;
  onChange: () => void;
  createId?: () => string;
  now?: () => string;
}) {
  const messages = new Map<string, OptimisticMessage>();

  async function attempt(clientMessageId: string) {
    const entry = messages.get(clientMessageId);
    if (!entry) return;
    const sending = { ...entry, status: "sending" as const };
    messages.set(clientMessageId, sending);
    onChange();
    try {
      const result = await deliver(sending);
      messages.delete(clientMessageId);
      onChange();
      return result;
    } catch (error) {
      messages.set(clientMessageId, { ...entry, status: "failed" });
      onChange();
      throw error;
    }
  }

  return {
    get(conversationId: string) {
      return [...messages.values()].filter((message) => message.conversationId === conversationId);
    },
    retry: attempt,
    send(conversationId: string, content: string) {
      const clientMessageId = createId();
      messages.set(clientMessageId, {
        clientMessageId, conversationId, senderId, content,
        createdAt: now(), status: "sending",
      });
      onChange();
      return attempt(clientMessageId);
    },
  };
}

export async function createChatClient({
  userId,
  baseUrl = chatUrl,
  request = fetch,
  socket = io(baseUrl, { autoConnect: false, transports: ["websocket"], withCredentials: true }),
  timers = window,
}: {
  userId: string;
  baseUrl?: string;
  request?: Request;
  socket?: Socket;
  timers?: Timers;
}) {
  const abort = new AbortController();
  const store = await openChatStore(userId);
  const changes = new EventTarget();
  const presence = new Map<string, Record<string, boolean>>();
  let activeConversationId: string | undefined;
  let typingConversationId: string | undefined;
  let typingInterval: number | undefined;
  let presenceInterval: number | undefined;
  let presenceTimeout: number | undefined;
  let presenceRequest = 0;
  const changed = () => changes.dispatchEvent(new Event("change"));
  const unsubscribeStore = store.subscribe(changed);
  const coordinator = createChatSyncCoordinator({ baseUrl, store, request, signal: abort.signal });
  const consumer = createLiveEventConsumer({ onMessage: coordinator.roomMessage, onAccountEvent: coordinator.accountEvent });
  const typing = createTypingTracker({ onChange: changed, timers });

  const read = createReadCoordinator({
    current: store.getReadSequence,
    async update(conversationId, sequence) {
      const value = markReadResponseSchema.parse(await json(await request(
        `${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/read`,
        { method: "PUT", credentials: "include", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sequence }), signal: abort.signal },
      )));
      return value.lastReadSequence;
    },
    confirmed: store.storeConfirmedRead,
  });

  const optimistic = createOptimisticQueue({
    senderId: userId,
    onChange: changed,
    async deliver(entry) {
      const message = messageSchema.parse(await json(await request(
        `${baseUrl}/api/conversations/${encodeURIComponent(entry.conversationId)}/messages`,
        { method: "POST", credentials: "include", headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientMessageId: entry.clientMessageId, content: entry.content }), signal: abort.signal },
      )));
      await store.storeRoomMessage(message);
      return message;
    },
  });

  function emitTypingStop() {
    if (typingInterval !== undefined) timers.clearInterval(typingInterval);
    typingInterval = undefined;
    if (typingConversationId) socket.emit("typing.stop", { conversationId: typingConversationId });
    typingConversationId = undefined;
  }

  function setTyping(conversationId: string, value: boolean) {
    if (!value) return emitTypingStop();
    if (typingConversationId === conversationId && typingInterval !== undefined) return;
    emitTypingStop();
    typingConversationId = conversationId;
    socket.emit("typing.start", { conversationId });
    typingInterval = timers.setInterval(() => socket.emit("typing.start", { conversationId }), 2_000);
  }

  function queryPresence() {
    if (!activeConversationId) return;
    const conversationId = activeConversationId;
    presenceRequest += 1;
    const requestId = presenceRequest;
    if (presenceTimeout !== undefined) timers.clearTimeout(presenceTimeout);
    presenceTimeout = timers.setTimeout(() => {
      if (requestId !== presenceRequest) return;
      presenceTimeout = undefined;
      presence.delete(conversationId);
      changed();
    }, 5_000);
    socket.emit("presence.get", { conversationId }, (input: unknown) => {
      if (requestId !== presenceRequest) return;
      if (presenceTimeout !== undefined) timers.clearTimeout(presenceTimeout);
      presenceTimeout = undefined;
      const result = presenceResponseSchema.safeParse(input);
      if (result.success) presence.set(conversationId, result.data.members);
      else presence.delete(conversationId);
      changed();
    });
  }

  function startPresence() {
    if (presenceInterval !== undefined) timers.clearInterval(presenceInterval);
    presenceInterval = undefined;
    if (!activeConversationId || document.visibilityState !== "visible") return;
    queryPresence();
    presenceInterval = timers.setInterval(queryPresence, 10_000);
  }

  function selectConversation(conversationId?: string) {
    presenceRequest += 1;
    emitTypingStop();
    if (activeConversationId) socket.emit("conversation.leave", { conversationId: activeConversationId });
    activeConversationId = conversationId;
    if (conversationId) socket.emit("conversation.join", { conversationId });
    startPresence();
    changed();
  }

  const onMessage = (input: unknown) => void consumer.messageCreated(input).catch(() => undefined);
  const onAccountEvent = (input: unknown) => void consumer.accountEvent(input).catch(() => undefined);
  const onTyping = (input: unknown) => {
    const result = typingChangedSchema.safeParse(input);
    if (result.success) typing.apply(result.data);
  };
  const onConnect = () => {
    rejoinActiveConversation(socket, activeConversationId);
    void coordinator.initialize().catch(() => undefined);
    void read.retry();
    startPresence();
  };
  const onDisconnect = () => {
    if (activeConversationId) presence.delete(activeConversationId);
    changed();
  };
  const visibilityChanged = () => { startPresence(); if (document.visibilityState === "visible") void read.retry(); };
  socket.on("message.created", onMessage);
  socket.on("account.event", onAccountEvent);
  socket.on("typing.changed", onTyping);
  socket.on("connect", onConnect);
  socket.on("disconnect", onDisconnect);
  document.addEventListener("visibilitychange", visibilityChanged);
  socket.connect();
  const stopForegroundSync = startForegroundSync({ synchronize: coordinator.initialize });
  void coordinator.initialize().catch(() => undefined);

  return {
    close() {
      abort.abort(); emitTypingStop(); selectConversation(); typing.clear(); stopForegroundSync();
      if (presenceInterval !== undefined) timers.clearInterval(presenceInterval);
      if (presenceTimeout !== undefined) timers.clearTimeout(presenceTimeout);
      document.removeEventListener("visibilitychange", visibilityChanged); unsubscribeStore();
      socket.off("message.created", onMessage); socket.off("account.event", onAccountEvent);
      socket.off("typing.changed", onTyping); socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect); socket.disconnect(); store.close();
    },
    async createConversation(input: { kind: "direct" | "group"; title?: string; memberIds: string[] }) {
      return conversationSchema.parse(await json(await request(`${baseUrl}/api/conversations`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify(input), signal: abort.signal,
      })));
    },
    getConversation: store.getConversation,
    getConversationList: store.getConversationList,
    async getMessages(conversationId: string) {
      const confirmed = await store.getMessages(conversationId);
      const pending = optimistic.get(conversationId);
      return { confirmed, pending };
    },
    getPresence(conversationId: string) { return presence.get(conversationId) ?? {}; },
    getTyping(conversationId: string) { return typing.get(conversationId); },
    loadHistory: coordinator.loadHistory,
    async lookupUser(email: string): Promise<DirectoryUser> {
      return directoryUserSchema.parse(await json(await request(`${baseUrl}/api/users/lookup`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }), signal: abort.signal,
      })));
    },
    markRead: read.propose,
    retryMessage: optimistic.retry,
    selectConversation,
    sendMessage: optimistic.send,
    setTyping,
    subscribe(listener: EventListener) {
      changes.addEventListener("change", listener);
      return () => changes.removeEventListener("change", listener);
    },
    synchronize: coordinator.synchronize,
  };
}

export type ChatClient = Awaited<ReturnType<typeof createChatClient>>;
