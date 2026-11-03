import type { ChatStore } from "./chat-store";
import {
  historyResponseSchema,
  syncEventResponseSchema,
  syncSnapshotResponseSchema,
  type AccountEvent,
  type Message,
} from "./chat-types";

type Store = Pick<
  ChatStore,
  | "applyEventPage"
  | "applyLiveEvent"
  | "getSyncToken"
  | "replaceSnapshot"
  | "storeHistory"
  | "storeRoomMessage"
>;

type Request = (input: string, init?: RequestInit) => Promise<Response>;

async function json(response: Response) {
  if (!response.ok) throw new Error(`Chat sync request failed with ${response.status}`);
  return response.json();
}

export function createChatSyncCoordinator({
  baseUrl,
  store,
  request = fetch,
  signal,
}: {
  baseUrl: string;
  store: Store;
  request?: Request;
  signal?: AbortSignal;
}) {
  let active: Promise<void> | undefined;
  let requested = false;
  let initialized = false;
  const queuedEvents: AccountEvent[] = [];

  async function snapshot(expectedToken: number | undefined) {
    const response = syncSnapshotResponseSchema.parse(
      await json(await request(`${baseUrl}/api/sync`, { credentials: "include", signal })),
    );
    return store.replaceSnapshot(response.conversations, response.nextToken, expectedToken);
  }

  async function synchronizeOnce() {
    while (!signal?.aborted) {
      const token = await store.getSyncToken();
      if (token === undefined) {
        const result = await snapshot(undefined);
        if (result.status === "stale") continue;
        continue;
      }

      const url = new URL("/api/sync", baseUrl);
      url.searchParams.set("after", String(token));
      url.searchParams.set("limit", "100");
      const response = syncEventResponseSchema.parse(
        await json(await request(url.toString(), { credentials: "include", signal })),
      );

      if (response.resetRequired) {
        const result = await snapshot(token);
        if (result.status === "stale") continue;
        continue;
      }

      const result = await store.applyEventPage(token, response.events, response.nextToken);
      if (result.status === "stale" || response.hasMore) continue;
      return;
    }
  }

  function synchronize() {
    requested = true;
    if (active) return active;

    active = (async () => {
      try {
        while (requested && !signal?.aborted) {
          requested = false;
          await synchronizeOnce();
        }
      } finally {
        active = undefined;
      }
    })();
    return active;
  }

  async function accountEvent(event: AccountEvent) {
    if (!initialized) {
      queuedEvents.push(event);
      return;
    }
    const result = await store.applyLiveEvent(event);
    if (result.status === "gap") await synchronize();
  }

  return {
    accountEvent,
    async initialize() {
      await synchronize();
      if (initialized) return;
      initialized = true;
      for (const event of queuedEvents.splice(0)) await accountEvent(event);
    },
    async loadHistory(conversationId: string, beforeSequence?: number) {
      const url = new URL(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, baseUrl);
      url.searchParams.set("limit", "50");
      if (beforeSequence !== undefined) {
        url.searchParams.set("beforeSequence", String(beforeSequence));
      }
      const response = historyResponseSchema.parse(
        await json(await request(url.toString(), { credentials: "include", signal })),
      );
      await store.storeHistory(response.messages);
      return response;
    },
    roomMessage: (message: Message) => store.storeRoomMessage(message),
    synchronize,
  };
}

export function startForegroundSync({
  synchronize,
  visibility = document,
  timers = window,
  intervalMs = 60_000,
}: {
  synchronize: () => Promise<void>;
  visibility?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  timers?: Pick<Window, "setInterval" | "clearInterval">;
  intervalMs?: number;
}) {
  let interval: number | undefined;

  function stopInterval() {
    if (interval !== undefined) timers.clearInterval(interval);
    interval = undefined;
  }

  function startInterval() {
    stopInterval();
    if (visibility.visibilityState !== "visible") return;
    interval = timers.setInterval(() => void synchronize().catch(() => undefined), intervalMs);
  }

  function changed() {
    if (visibility.visibilityState === "visible") void synchronize().catch(() => undefined);
    startInterval();
  }

  visibility.addEventListener("visibilitychange", changed);
  startInterval();

  return () => {
    stopInterval();
    visibility.removeEventListener("visibilitychange", changed);
  };
}
