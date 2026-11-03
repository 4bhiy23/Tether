import { z } from "zod";

const sequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSequenceSchema = sequenceSchema.positive();

export const messageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  sequence: positiveSequenceSchema,
  senderId: z.string().min(1),
  clientMessageId: z.uuid(),
  content: z.string().max(10_000).refine((value) => value.trim().length > 0),
  createdAt: z.iso.datetime(),
});

export const conversationSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(["direct", "group"]),
    title: z.string().max(100).nullable(),
    memberIds: z.array(z.string().min(1)).min(2).max(50),
    createdAt: z.iso.datetime(),
  })
  .refine(
    ({ kind, memberIds }) =>
      new Set(memberIds).size === memberIds.length &&
      (kind === "direct" ? memberIds.length === 2 : memberIds.length >= 3),
    { message: "Conversation membership does not match its kind" },
  );

const accountEventPayloadSchema = z.object({
  message: messageSchema,
  conversation: conversationSchema,
});

export const accountEventSchema = z
  .object({
    id: z.uuid(),
    userId: z.string().min(1),
    sequence: positiveSequenceSchema,
    type: z.literal("message.created"),
    conversationId: z.uuid(),
    messageId: z.uuid(),
    payload: accountEventPayloadSchema,
    createdAt: z.iso.datetime(),
  })
  .refine(
    ({ conversationId, messageId, payload, userId }) =>
      payload.conversation.id === conversationId &&
      payload.message.conversationId === conversationId &&
      payload.message.id === messageId &&
      payload.conversation.memberIds.includes(userId),
    { message: "Event references do not match its payload" },
  );

const eventPageSchema = z
  .object({
    mode: z.literal("events"),
    events: z.array(accountEventSchema),
    nextToken: sequenceSchema,
    hasMore: z.boolean(),
    resetRequired: z.literal(false),
  })
  .refine(
    ({ events }) => events.every((event, index) => index === 0 || event.sequence === events[index - 1].sequence + 1),
    { message: "Events must be contiguous" },
  )
  .refine(
    ({ events, nextToken }) => events.length === 0 || events.at(-1)?.sequence === nextToken,
    { message: "The next token must match the last event" },
  );

const resetPageSchema = z.object({
  mode: z.literal("events"),
  events: z.tuple([]),
  nextToken: sequenceSchema,
  hasMore: z.literal(false),
  resetRequired: z.literal(true),
});

export const syncEventResponseSchema = z.union([eventPageSchema, resetPageSchema]);

export const snapshotConversationSchema = conversationSchema
  .safeExtend({ messages: z.array(messageSchema).min(1).max(50) })
  .refine(
    ({ id, messages }) =>
      messages.every(
        (message, index) =>
          message.conversationId === id &&
          (index === 0 || message.sequence > messages[index - 1].sequence),
      ),
    { message: "Snapshot messages must belong to their conversation" },
  );

export const syncSnapshotResponseSchema = z.object({
  mode: z.literal("snapshot"),
  conversations: z.array(snapshotConversationSchema),
  nextToken: sequenceSchema,
  resetRequired: z.literal(false),
});

export const historyResponseSchema = z.object({
  messages: z.array(messageSchema),
  nextBeforeSequence: positiveSequenceSchema.nullable(),
  hasMore: z.boolean(),
});

export type Message = z.infer<typeof messageSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type AccountEvent = z.infer<typeof accountEventSchema>;
export type SyncEventResponse = z.infer<typeof syncEventResponseSchema>;
export type SnapshotConversation = z.infer<typeof snapshotConversationSchema>;
export type SyncSnapshotResponse = z.infer<typeof syncSnapshotResponseSchema>;
export type HistoryResponse = z.infer<typeof historyResponseSchema>;
