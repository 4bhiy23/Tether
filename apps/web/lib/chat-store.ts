import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { AccountEvent, Conversation, Message, SnapshotConversation } from "./chat-types";

const syncTokenKey = "syncToken";

interface ChatDatabase extends DBSchema {
  conversations: {
    key: string;
    value: Conversation;
  };
  messages: {
    key: string;
    value: Message;
    indexes: { "by-conversation-sequence": [string, number] };
  };
  meta: {
    key: string;
    value: number;
  };
}

function sameToken(left: number | undefined, right: number | undefined) {
  return left === right;
}

function materialize(event: AccountEvent) {
  return {
    conversation: event.payload.conversation,
    message: event.payload.message,
  };
}

export async function openChatStore(userId: string) {
  const database = await openDB<ChatDatabase>(`tether-chat:${userId}`, 1, {
    upgrade(db) {
      db.createObjectStore("conversations", { keyPath: "id" });
      const messages = db.createObjectStore("messages", { keyPath: "id" });
      messages.createIndex("by-conversation-sequence", ["conversationId", "sequence"]);
      db.createObjectStore("meta");
    },
  });

  return createChatStore(database);
}

export function createChatStore(database: IDBPDatabase<ChatDatabase>) {
  async function getSyncToken() {
    return database.get("meta", syncTokenKey);
  }

  async function applyEventPage(
    expectedToken: number,
    events: AccountEvent[],
    nextToken: number,
  ) {
    const validSequence = events.every(
      (event, index) => event.sequence === expectedToken + index + 1,
    );
    const expectedNextToken = events.at(-1)?.sequence ?? expectedToken;
    if (!validSequence || nextToken !== expectedNextToken) {
      throw new Error("Invalid event page sequence");
    }

    const transaction = database.transaction(
      ["conversations", "messages", "meta"],
      "readwrite",
    );
    const storedToken = await transaction.objectStore("meta").get(syncTokenKey);
    if (!sameToken(storedToken, expectedToken)) {
      await transaction.done;
      return { status: "stale", token: storedToken } as const;
    }

    for (const event of events) {
      const { conversation, message } = materialize(event);
      await transaction.objectStore("conversations").put(conversation);
      await transaction.objectStore("messages").put(message);
    }
    await transaction.objectStore("meta").put(nextToken, syncTokenKey);
    await transaction.done;
    return { status: "applied", token: nextToken } as const;
  }

  async function applyLiveEvent(event: AccountEvent) {
    const transaction = database.transaction(
      ["conversations", "messages", "meta"],
      "readwrite",
    );
    const storedToken = await transaction.objectStore("meta").get(syncTokenKey);
    if (storedToken === undefined || event.sequence > storedToken + 1) {
      await transaction.done;
      return { status: "gap", token: storedToken } as const;
    }
    if (event.sequence <= storedToken) {
      await transaction.done;
      return { status: "replay", token: storedToken } as const;
    }

    const { conversation, message } = materialize(event);
    await transaction.objectStore("conversations").put(conversation);
    await transaction.objectStore("messages").put(message);
    await transaction.objectStore("meta").put(event.sequence, syncTokenKey);
    await transaction.done;
    return { status: "applied", token: event.sequence } as const;
  }

  async function storeRoomMessage(message: Message) {
    await database.put("messages", message);
  }

  async function storeHistory(messages: Message[]) {
    const transaction = database.transaction("messages", "readwrite");
    for (const message of messages) await transaction.store.put(message);
    await transaction.done;
  }

  async function replaceSnapshot(
    conversations: SnapshotConversation[],
    nextToken: number,
    expectedToken: number | undefined,
  ) {
    const transaction = database.transaction(
      ["conversations", "messages", "meta"],
      "readwrite",
    );
    const storedToken = await transaction.objectStore("meta").get(syncTokenKey);
    if (!sameToken(storedToken, expectedToken)) {
      await transaction.done;
      return { status: "stale", token: storedToken } as const;
    }

    // shortcut: snapshots are replaced in one transaction, paginate or stage them before production-scale accounts
    await Promise.all([
      transaction.objectStore("conversations").clear(),
      transaction.objectStore("messages").clear(),
    ]);
    for (const { messages, ...conversation } of conversations) {
      await transaction.objectStore("conversations").put(conversation);
      for (const message of messages) await transaction.objectStore("messages").put(message);
    }
    await transaction.objectStore("meta").put(nextToken, syncTokenKey);
    await transaction.done;
    return { status: "applied", token: nextToken } as const;
  }

  return {
    applyEventPage,
    applyLiveEvent,
    close: () => database.close(),
    getConversation: (id: string) => database.get("conversations", id),
    getMessage: (id: string) => database.get("messages", id),
    getMessages: () => database.getAll("messages"),
    getSyncToken,
    replaceSnapshot,
    storeHistory,
    storeRoomMessage,
  };
}

export type ChatStore = Awaited<ReturnType<typeof openChatStore>>;
