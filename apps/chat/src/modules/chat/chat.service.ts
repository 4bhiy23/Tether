import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../../db.js";
import {
  accountEvents,
  conversationMembers,
  conversations,
  messages,
  outboxEvents,
  userSyncState,
} from "../../db/schema.js";

type Database = typeof db;
type Message = typeof messages.$inferSelect;

function isSameSend(
  message: Message,
  conversationId: string,
  input: { clientMessageId: string; content: string },
) {
  return message.conversationId === conversationId && message.content === input.content;
}

function isIdempotencyConflict(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "constraint" in error &&
    error.constraint === "messages_sender_client_message_unique"
  );
}

export function createChatService(database: Database = db) {
  async function findMessage(senderId: string, clientMessageId: string) {
    const [message] = await database
      .select()
      .from(messages)
      .where(and(eq(messages.senderId, senderId), eq(messages.clientMessageId, clientMessageId)))
      .limit(1);
    return message;
  }

  async function getConversationAccess(userId: string, conversationId: string) {
    const [conversation] = await database
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conversation) return { status: "not-found" } as const;

    const [membership] = await database
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .limit(1);
    return membership ? ({ status: "member" } as const) : ({ status: "forbidden" } as const);
  }

  return {
    getConversationAccess,

    async getConversationMemberIds(userId: string, conversationId: string) {
      const [conversation] = await database
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (!conversation) return { status: "not-found" } as const;
      const members = await database.execute<{ userId: string }>(sql`
        select "member"."user_id" as "userId"
        from ${conversationMembers} as "member"
        where "member"."conversation_id" = ${conversationId}
          and exists (
            select 1 from ${conversationMembers} as "requester"
            where "requester"."conversation_id" = ${conversationId}
              and "requester"."user_id" = ${userId}
          )
        order by "member"."user_id"
      `);
      return members.rows.length
        ? ({ status: "found", memberIds: members.rows.map(({ userId: id }) => id) } as const)
        : ({ status: "forbidden" } as const);
    },

    async createConversation(
      userId: string,
      input: { kind: "direct" | "group"; title?: string; memberIds: string[] },
    ) {
      return database.transaction(async (tx) => {
        const memberIds = [...new Set([userId, ...input.memberIds])].sort();
        const validSize =
          input.kind === "direct"
            ? memberIds.length === 2
            : memberIds.length >= 3 && memberIds.length <= 50;
        if (!validSize) return { status: "invalid-members" } as const;

        const existingUsers = await tx.execute<{ id: string; name: string; email: string }>(sql`
          select id, name, email from "user"
          where id in (${sql.join(
            memberIds.map((memberId) => sql`${memberId}`),
            sql`, `,
          )})
          order by id
        `);
        if (existingUsers.rows.length !== memberIds.length) {
          return { status: "invalid-members" } as const;
        }

        const directKey = input.kind === "direct" ? JSON.stringify(memberIds) : null;
        const [created] = await tx
          .insert(conversations)
          .values({ kind: input.kind, title: input.title, directKey, createdBy: userId })
          .onConflictDoNothing({ target: conversations.directKey })
          .returning();

        const [conversation] = created
          ? [created]
          : await tx
              .select()
              .from(conversations)
              .where(eq(conversations.directKey, directKey!))
              .limit(1);

        if (!created) {
          const { directKey: _, ...storedConversation } = conversation;
          return {
            status: "created",
            conversation: { ...storedConversation, memberIds, members: existingUsers.rows },
          } as const;
        }

        await tx
          .insert(conversationMembers)
          .values(memberIds.map((memberId) => ({ conversationId: conversation.id, userId: memberId })));

        const { directKey: _, ...storedConversation } = conversation;
        return {
          status: "created",
          conversation: { ...storedConversation, memberIds, members: existingUsers.rows },
        } as const;
      });
    },

    async sendMessage(
      userId: string,
      conversationId: string,
      input: { clientMessageId: string; content: string },
    ) {
      try {
        return await database.transaction(async (tx) => {
          const [conversation] = await tx
            .select({
              id: conversations.id,
              kind: conversations.kind,
              title: conversations.title,
              createdAt: conversations.createdAt,
            })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .for("update")
            .limit(1);
          if (!conversation) return { status: "not-found" } as const;

          const [membership] = await tx
            .select({ userId: conversationMembers.userId })
            .from(conversationMembers)
            .where(
              and(
                eq(conversationMembers.conversationId, conversationId),
                eq(conversationMembers.userId, userId),
              ),
            )
            .limit(1);
          if (!membership) return { status: "forbidden" } as const;

          const [existing] = await tx
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.senderId, userId),
                eq(messages.clientMessageId, input.clientMessageId),
              ),
            )
            .limit(1);
          if (existing) {
            return isSameSend(existing, conversationId, input)
              ? ({ status: "sent", message: existing, replayed: true } as const)
              : ({ status: "idempotency-conflict" } as const);
          }

          const [updatedConversation] = await tx
            .update(conversations)
            .set({ nextMessageSequence: sql`${conversations.nextMessageSequence} + 1` })
            .where(eq(conversations.id, conversationId))
            .returning({ sequence: conversations.nextMessageSequence });

          const [message] = await tx
            .insert(messages)
            .values({
              conversationId,
              sequence: updatedConversation.sequence,
              senderId: userId,
              clientMessageId: input.clientMessageId,
              content: input.content,
            })
            .returning();

          const members = await tx.execute<{ id: string; name: string; email: string }>(sql`
            select "user".id, "user".name, "user".email
            from ${conversationMembers}
            inner join "user" on "user".id = ${conversationMembers.userId}
            where ${conversationMembers.conversationId} = ${conversationId}
            order by "user".id
          `);
          const eventPayload = {
            message,
            conversation: {
              ...conversation,
              memberIds: members.rows.map(({ id }) => id),
              members: members.rows,
            },
          };
          await tx
            .insert(userSyncState)
            .values(members.rows.map(({ id }) => ({ userId: id })))
            .onConflictDoNothing();

          for (const { id: memberId } of members.rows) {
            const [state] = await tx
              .update(userSyncState)
              .set({ nextSequence: sql`${userSyncState.nextSequence} + 1` })
              .where(eq(userSyncState.userId, memberId))
              .returning({ sequence: userSyncState.nextSequence });
            await tx.insert(accountEvents).values({
              userId: memberId,
              sequence: state.sequence,
              type: "message.created",
              conversationId,
              messageId: message.id,
              payload: eventPayload,
            });
          }

          await tx.insert(outboxEvents).values({
            type: "message.created",
            messageId: message.id,
            payload: { message, userIds: members.rows.map(({ id }) => id) },
          });

          return { status: "sent", message, replayed: false } as const;
        });
      } catch (error) {
        if (!isIdempotencyConflict(error)) throw error;
        const message = await findMessage(userId, input.clientMessageId);
        return message && isSameSend(message, conversationId, input)
          ? ({ status: "sent", message, replayed: true } as const)
          : ({ status: "idempotency-conflict" } as const);
      }
    },

    async listMessages(
      userId: string,
      conversationId: string,
      input: { beforeSequence?: number; limit: number },
    ) {
      return database.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .limit(1);
        if (!conversation) return { status: "not-found" } as const;

        const [membership] = await tx
          .select({ userId: conversationMembers.userId })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.userId, userId),
            ),
          )
          .for("key share")
          .limit(1);
        if (!membership) return { status: "forbidden" } as const;

        const rows = await tx
          .select({ message: messages })
          .from(messages)
          .innerJoin(
            conversationMembers,
            and(
              eq(conversationMembers.conversationId, messages.conversationId),
              eq(conversationMembers.userId, userId),
            ),
          )
          .where(
            and(
              eq(messages.conversationId, conversationId),
              input.beforeSequence === undefined
                ? undefined
                : lt(messages.sequence, input.beforeSequence),
            ),
          )
          .orderBy(desc(messages.sequence))
          .limit(input.limit + 1);
        const hasMore = rows.length > input.limit;
        const page = rows.slice(0, input.limit).map(({ message }) => message).reverse();

        return {
          status: "found",
          messages: page,
          nextBeforeSequence: hasMore ? page[0]?.sequence ?? null : null,
          hasMore,
        } as const;
      });
    },
  };
}

export const chatService = createChatService();
export type ChatService = typeof chatService;
export type StoredMessage = Message;
