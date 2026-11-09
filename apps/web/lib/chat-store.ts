import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from "idb";
import type { AccountEvent, Conversation, ConversationSummary, Message, SnapshotConversation } from "./chat-types";

const syncTokenKey = "syncToken";
type ReadState = { conversationId: string; lastReadSequence: number };

interface ChatDatabase extends DBSchema {
  conversations: { key: string; value: Conversation };
  messages: { key: string; value: Message; indexes: { "by-conversation-sequence": [string, number] } };
  readState: { key: string; value: ReadState };
  meta: { key: string; value: number };
}

function sameToken(left: number | undefined, right: number | undefined) { return left === right; }

export async function openChatStore(userId: string) {
  const database = await openDB<ChatDatabase>(`tether-chat:${userId}`, 2, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion === 0) {
        db.createObjectStore("conversations", { keyPath: "id" });
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("by-conversation-sequence", ["conversationId", "sequence"]);
        db.createObjectStore("meta");
      }
      if (oldVersion < 2) {
        db.createObjectStore("readState", { keyPath: "conversationId" });
        if (oldVersion > 0) void transaction.objectStore("meta").delete(syncTokenKey);
      }
    },
  });
  return createChatStore(database);
}

export function createChatStore(database: IDBPDatabase<ChatDatabase>) {
  const changes = new EventTarget();
  const notify = () => changes.dispatchEvent(new Event("change"));

  async function applyProjection(
    transaction: IDBPTransaction<ChatDatabase, ("conversations" | "messages" | "readState" | "meta")[], "readwrite">,
    event: AccountEvent,
  ) {
    if (event.type === "message.created") {
      await transaction.objectStore("conversations").put(event.payload.conversation);
      await transaction.objectStore("messages").put(event.payload.message);
    } else {
      const store = transaction.objectStore("readState");
      const current = await store.get(event.conversationId);
      if (!current || event.payload.lastReadSequence > current.lastReadSequence) {
        await store.put({ conversationId: event.conversationId, lastReadSequence: event.payload.lastReadSequence });
      }
    }
  }

  const getSyncToken = () => database.get("meta", syncTokenKey);

  async function applyEventPage(expectedToken: number, events: AccountEvent[], nextToken: number) {
    const validSequence = events.every((event, index) => event.sequence === expectedToken + index + 1);
    if (!validSequence || nextToken !== (events.at(-1)?.sequence ?? expectedToken)) {
      throw new Error("Invalid event page sequence");
    }
    const transaction = database.transaction(["conversations", "messages", "readState", "meta"], "readwrite");
    const storedToken = await transaction.objectStore("meta").get(syncTokenKey);
    if (!sameToken(storedToken, expectedToken)) {
      await transaction.done;
      return { status: "stale", token: storedToken } as const;
    }
    for (const event of events) await applyProjection(transaction, event);
    await transaction.objectStore("meta").put(nextToken, syncTokenKey);
    await transaction.done;
    notify();
    return { status: "applied", token: nextToken } as const;
  }

  async function applyLiveEvent(event: AccountEvent) {
    const transaction = database.transaction(["conversations", "messages", "readState", "meta"], "readwrite");
    const storedToken = await transaction.objectStore("meta").get(syncTokenKey);
    if (storedToken === undefined || event.sequence > storedToken + 1) {
      await transaction.done;
      return { status: "gap", token: storedToken } as const;
    }
    if (event.sequence <= storedToken) {
      await transaction.done;
      return { status: "replay", token: storedToken } as const;
    }
    await applyProjection(transaction, event);
    await transaction.objectStore("meta").put(event.sequence, syncTokenKey);
    await transaction.done;
    notify();
    return { status: "applied", token: event.sequence } as const;
  }

  async function storeRoomMessage(message: Message) { await database.put("messages", message); notify(); }
  async function storeHistory(messages: Message[]) {
    const transaction = database.transaction("messages", "readwrite");
    for (const message of messages) await transaction.store.put(message);
    await transaction.done; notify();
  }
  async function storeConfirmedRead(conversationId: string, lastReadSequence: number) {
    const transaction = database.transaction("readState", "readwrite");
    const current = await transaction.store.get(conversationId);
    if (current && lastReadSequence <= current.lastReadSequence) return transaction.done;
    await transaction.store.put({ conversationId, lastReadSequence });
    await transaction.done; notify();
  }

  async function replaceSnapshot(conversations: SnapshotConversation[], nextToken: number, expectedToken: number | undefined) {
    const transaction = database.transaction(["conversations", "messages", "readState", "meta"], "readwrite");
    const storedToken = await transaction.objectStore("meta").get(syncTokenKey);
    if (!sameToken(storedToken, expectedToken)) {
      await transaction.done;
      return { status: "stale", token: storedToken } as const;
    }
    // shortcut: snapshots are replaced in one transaction, paginate or stage them before production-scale accounts
    await Promise.all([
      transaction.objectStore("conversations").clear(), transaction.objectStore("messages").clear(),
      transaction.objectStore("readState").clear(),
    ]);
    for (const { messages, lastReadSequence, ...conversation } of conversations) {
      await transaction.objectStore("conversations").put(conversation);
      await transaction.objectStore("readState").put({ conversationId: conversation.id, lastReadSequence });
      for (const message of messages) await transaction.objectStore("messages").put(message);
    }
    await transaction.objectStore("meta").put(nextToken, syncTokenKey);
    await transaction.done; notify();
    return { status: "applied", token: nextToken } as const;
  }

  async function getMessages(conversationId?: string) {
    if (!conversationId) return database.getAll("messages");
    return database.getAllFromIndex("messages", "by-conversation-sequence",
      IDBKeyRange.bound([conversationId, 0], [conversationId, Number.MAX_SAFE_INTEGER]));
  }

  async function getConversationList(): Promise<ConversationSummary[]> {
    const [conversations, messages, reads] = await Promise.all([
      database.getAll("conversations"), database.getAll("messages"), database.getAll("readState"),
    ]);
    const readByConversation = new Map(reads.map((read) => [read.conversationId, read.lastReadSequence]));
    const latestByConversation = new Map<string, Message>();
    for (const message of messages) {
      const latest = latestByConversation.get(message.conversationId);
      if (!latest || message.sequence > latest.sequence) latestByConversation.set(message.conversationId, message);
    }
    return conversations.flatMap((conversation) => {
      const latestMessage = latestByConversation.get(conversation.id);
      return latestMessage ? [{ conversation, latestMessage,
        unreadCount: Math.max(0, latestMessage.sequence - (readByConversation.get(conversation.id) ?? 0)) }] : [];
    }).sort((left, right) =>
      right.latestMessage.createdAt.localeCompare(left.latestMessage.createdAt) ||
      right.latestMessage.sequence - left.latestMessage.sequence ||
      left.conversation.id.localeCompare(right.conversation.id));
  }

  return {
    applyEventPage, applyLiveEvent, close: () => database.close(),
    getConversation: (id: string) => database.get("conversations", id), getConversationList,
    getMessage: (id: string) => database.get("messages", id), getMessages,
    getReadSequence: async (id: string) => (await database.get("readState", id))?.lastReadSequence ?? 0,
    getSyncToken, replaceSnapshot, storeConfirmedRead, storeHistory, storeRoomMessage,
    subscribe(listener: EventListener) { changes.addEventListener("change", listener); return () => changes.removeEventListener("change", listener); },
  };
}

export type ChatStore = Awaited<ReturnType<typeof openChatStore>>;
