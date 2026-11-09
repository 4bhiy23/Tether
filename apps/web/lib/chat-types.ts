import { z } from "zod";

const sequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSequenceSchema = sequenceSchema.positive();

export const memberSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.email(),
});

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
    members: z.array(memberSchema).min(2).max(50),
    createdAt: z.iso.datetime(),
  })
  .refine(
    ({ kind, memberIds, members }) => {
      const profileIds = members.map(({ id }) => id);
      return (
        new Set(memberIds).size === memberIds.length &&
        new Set(profileIds).size === profileIds.length &&
        memberIds.every((id) => profileIds.includes(id)) &&
        profileIds.every((id) => memberIds.includes(id)) &&
        (kind === "direct" ? memberIds.length === 2 : memberIds.length >= 3)
      );
    },
    { message: "Conversation membership does not match its kind" },
  );

const messageCreatedEventSchema = z
  .object({
    id: z.uuid(), userId: z.string().min(1), sequence: positiveSequenceSchema,
    type: z.literal("message.created"), conversationId: z.uuid(), messageId: z.uuid(),
    payload: z.object({ message: messageSchema, conversation: conversationSchema }),
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

const conversationReadEventSchema = z
  .object({
    id: z.uuid(), userId: z.string().min(1), sequence: positiveSequenceSchema,
    type: z.literal("conversation.read"), conversationId: z.uuid(), messageId: z.null(),
    payload: z.object({ conversationId: z.uuid(), lastReadSequence: positiveSequenceSchema }),
    createdAt: z.iso.datetime(),
  })
  .refine(({ conversationId, payload }) => payload.conversationId === conversationId, {
    message: "Event references do not match its payload",
  });

export const accountEventSchema = z.discriminatedUnion("type", [
  messageCreatedEventSchema,
  conversationReadEventSchema,
]);

const eventPageSchema = z
  .object({
    mode: z.literal("events"), events: z.array(accountEventSchema), nextToken: sequenceSchema,
    hasMore: z.boolean(), resetRequired: z.literal(false),
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
  mode: z.literal("events"), events: z.tuple([]), nextToken: sequenceSchema,
  hasMore: z.literal(false), resetRequired: z.literal(true),
});

export const syncEventResponseSchema = z.union([eventPageSchema, resetPageSchema]);

export const snapshotConversationSchema = conversationSchema
  .safeExtend({ messages: z.array(messageSchema).min(1).max(50), lastReadSequence: sequenceSchema })
  .refine(
    ({ id, messages }) => messages.every(
      (message, index) => message.conversationId === id &&
        (index === 0 || message.sequence > messages[index - 1].sequence),
    ),
    { message: "Snapshot messages must belong to their conversation" },
  );

export const syncSnapshotResponseSchema = z.object({
  mode: z.literal("snapshot"), conversations: z.array(snapshotConversationSchema),
  nextToken: sequenceSchema, resetRequired: z.literal(false),
});

export const historyResponseSchema = z.object({
  messages: z.array(messageSchema), nextBeforeSequence: positiveSequenceSchema.nullable(),
  hasMore: z.boolean(),
});

export const directoryUserSchema = memberSchema;
export const markReadResponseSchema = z.object({
  conversationId: z.uuid(),
  lastReadSequence: positiveSequenceSchema,
});
export const typingChangedSchema = z.object({
  conversationId: z.uuid(), userId: z.string().min(1), isTyping: z.boolean(),
});
export const presenceResponseSchema = z.object({
  status: z.literal("ok"), members: z.record(z.string(), z.boolean()),
});

export type Message = z.infer<typeof messageSchema>;
export type ConversationMember = z.infer<typeof memberSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type AccountEvent = z.infer<typeof accountEventSchema>;
export type SnapshotConversation = z.infer<typeof snapshotConversationSchema>;
export type DirectoryUser = z.infer<typeof directoryUserSchema>;
export type TypingChanged = z.infer<typeof typingChangedSchema>;
export type ConversationSummary = { conversation: Conversation; latestMessage: Message; unreadCount: number };
export type OptimisticMessage = {
  clientMessageId: string; conversationId: string; senderId: string; content: string;
  createdAt: string; status: "sending" | "failed";
};
