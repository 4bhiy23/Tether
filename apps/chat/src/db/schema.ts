import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Better Auth owns the user table; the SQL migration adds user foreign keys without managing it here.
export const conversations = pgTable(
  "conversations",
  {
    id: uuid().defaultRandom().primaryKey(),
    kind: text().notNull(),
    title: text(),
    directKey: text("direct_key"),
    nextMessageSequence: bigint("next_message_sequence", { mode: "number" }).default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("conversations_kind_check", sql`${table.kind} in ('direct', 'group')`),
    unique("conversations_direct_key_unique").on(table.directKey),
  ],
);

export const conversationMembers = pgTable(
  "conversation_members",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.userId] })],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid().defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sequence: bigint({ mode: "number" }).notNull(),
    senderId: text("sender_id").notNull(),
    clientMessageId: uuid("client_message_id").notNull(),
    content: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("messages_conversation_sequence_unique").on(table.conversationId, table.sequence),
    unique("messages_sender_client_message_unique").on(table.senderId, table.clientMessageId),
  ],
);

export const userSyncState = pgTable("user_sync_state", {
  userId: text("user_id").primaryKey(),
  nextSequence: bigint("next_sequence", { mode: "number" }).default(0).notNull(),
});

export const accountEvents = pgTable(
  "account_events",
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    sequence: bigint({ mode: "number" }).notNull(),
    type: text().notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    payload: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("account_events_user_sequence_unique").on(table.userId, table.sequence),
    unique("account_events_user_message_unique").on(table.userId, table.messageId),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid().defaultRandom().primaryKey(),
    type: text().notNull(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    payload: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    unique("outbox_events_message_unique").on(table.messageId),
    index("outbox_events_pending_created_at_idx")
      .on(table.createdAt)
      .where(sql`${table.publishedAt} is null`),
  ],
);
