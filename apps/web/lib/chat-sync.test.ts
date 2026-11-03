import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AccountEvent, Conversation, Message, SnapshotConversation } from "./chat-types";
import { createChatSyncCoordinator, startForegroundSync } from "./chat-sync";

const createdAt = "2026-11-03T10:00:00.000Z";

function records(sequence: number): { event: AccountEvent; snapshot: SnapshotConversation } {
  const conversation: Conversation = {
    id: randomUUID(),
    kind: "direct",
    title: null,
    memberIds: ["alice", "bob"],
    createdAt,
  };
  const message: Message = {
    id: randomUUID(),
    conversationId: conversation.id,
    sequence,
    senderId: "alice",
    clientMessageId: randomUUID(),
    content: `message ${sequence}`,
    createdAt,
  };
  return {
    event: {
      id: randomUUID(),
      userId: "bob",
      sequence,
      type: "message.created",
      conversationId: conversation.id,
      messageId: message.id,
      payload: { conversation, message },
      createdAt,
    },
    snapshot: { ...conversation, messages: [message] },
  };
}

function response(value: unknown) {
  return Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
}

function fakeStore(initialToken?: number) {
  let token = initialToken;
  const applied: number[] = [];
  return {
    applied,
    async applyEventPage(expected: number, events: AccountEvent[], next: number) {
      if (token !== expected) return { status: "stale", token } as const;
      applied.push(...events.map((event) => event.sequence));
      token = next;
      return { status: "applied", token: next } as const;
    },
    async applyLiveEvent(event: AccountEvent) {
      if (token === undefined || event.sequence > token + 1) {
        return { status: "gap", token } as const;
      }
      if (event.sequence <= token) return { status: "replay", token } as const;
      applied.push(event.sequence);
      token = event.sequence;
      return { status: "applied", token } as const;
    },
    async getSyncToken() {
      return token;
    },
    async replaceSnapshot(_conversations: SnapshotConversation[], next: number, expected?: number) {
      if (token !== expected) return { status: "stale", token } as const;
      token = next;
      return { status: "applied", token: next } as const;
    },
    async storeHistory() {},
    async storeRoomMessage() {},
  };
}

test("initializes from a snapshot then immediately catches up before queued live events", async () => {
  const { event, snapshot } = records(1);
  const store = fakeStore();
  let requests = 0;
  const coordinator = createChatSyncCoordinator({
    baseUrl: "http://chat.test",
    store,
    request: () => {
      requests += 1;
      if (requests === 1) {
        return response({ mode: "snapshot", conversations: [snapshot], nextToken: 0, resetRequired: false });
      }
      return response({
        mode: "events",
        events: [event],
        nextToken: 1,
        hasMore: false,
        resetRequired: false,
      });
    },
  });

  await coordinator.accountEvent(event);
  await coordinator.initialize();

  assert.equal(requests, 2);
  assert.deepEqual(store.applied, [1]);
  assert.equal(await store.getSyncToken(), 1);
});

test("uses stored zero for incremental initialization and synchronizes gaps", async () => {
  const first = records(1).event;
  const second = records(2).event;
  const store = fakeStore(0);
  let requests = 0;
  const coordinator = createChatSyncCoordinator({
    baseUrl: "http://chat.test",
    store,
    request: () => {
      requests += 1;
      return response({
        mode: "events",
        events: requests === 1 ? [first] : [second],
        nextToken: requests,
        hasMore: false,
        resetRequired: false,
      });
    },
  });

  await coordinator.initialize();
  await coordinator.accountEvent(records(3).event);

  assert.equal(requests, 2);
  assert.deepEqual(store.applied, [1, 2]);
});

test("rebuilds on reset and catches up from the snapshot token", async () => {
  const store = fakeStore(4);
  const event = records(6).event;
  const replies = [
    { mode: "events", events: [], nextToken: 4, hasMore: false, resetRequired: true },
    { mode: "snapshot", conversations: [], nextToken: 5, resetRequired: false },
    { mode: "events", events: [event], nextToken: 6, hasMore: false, resetRequired: false },
  ];
  const coordinator = createChatSyncCoordinator({
    baseUrl: "http://chat.test",
    store,
    request: () => response(replies.shift()),
  });

  await coordinator.initialize();

  assert.deepEqual(store.applied, [6]);
  assert.equal(await store.getSyncToken(), 6);
  assert.equal(replies.length, 0);
});

test("retries initialization after a transient request failure", async () => {
  const store = fakeStore(0);
  let requests = 0;
  const coordinator = createChatSyncCoordinator({
    baseUrl: "http://chat.test",
    store,
    request: () => {
      requests += 1;
      if (requests === 1) return Promise.resolve(new Response(null, { status: 503 }));
      return response({
        mode: "events",
        events: [],
        nextToken: 0,
        hasMore: false,
        resetRequired: false,
      });
    },
  });

  await assert.rejects(coordinator.initialize(), /503/);
  await coordinator.initialize();

  assert.equal(requests, 2);
});

test("coalesces simultaneous synchronization triggers", async () => {
  const store = fakeStore(0);
  let requests = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const coordinator = createChatSyncCoordinator({
    baseUrl: "http://chat.test",
    store,
    request: async () => {
      requests += 1;
      await waiting;
      return response({ mode: "events", events: [], nextToken: 0, hasMore: false, resetRequired: false });
    },
  });

  const first = coordinator.synchronize();
  const second = coordinator.synchronize();
  release();
  await Promise.all([first, second]);

  assert.equal(requests, 2);
});

test("runs foreground synchronization only while visible", async () => {
  let state: DocumentVisibilityState = "hidden";
  let changed!: () => void;
  let intervalCallback!: () => void;
  let calls = 0;
  const stop = startForegroundSync({
    synchronize: async () => {
      calls += 1;
    },
    visibility: {
      get visibilityState() {
        return state;
      },
      addEventListener: ((_name: string, listener: EventListenerOrEventListenerObject) => {
        changed = listener as () => void;
      }) as Document["addEventListener"],
      removeEventListener: () => {},
    },
    timers: {
      setInterval: ((callback: () => void) => {
        intervalCallback = callback;
        return 1;
      }) as typeof window.setInterval,
      clearInterval: () => {},
    },
  });

  assert.equal(calls, 0);
  state = "visible";
  changed();
  await Promise.resolve();
  assert.equal(calls, 1);
  intervalCallback();
  assert.equal(calls, 2);
  state = "hidden";
  changed();
  stop();
});
