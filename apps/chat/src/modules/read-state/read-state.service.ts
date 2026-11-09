import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db.js";
import {
  accountEvents,
  conversationMembers,
  conversationReadState,
  conversations,
  messages,
  outboxEvents,
  userSyncState,
} from "../../db/schema.js";

type Database = typeof db;

export function createReadStateService(database: Database = db) {
  return {
    async markRead(userId: string, conversationId: string, sequence: number) {
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

        const [message] = await tx
          .select({ sequence: messages.sequence })
          .from(messages)
          .where(and(eq(messages.conversationId, conversationId), eq(messages.sequence, sequence)))
          .limit(1);
        if (!message) return { status: "invalid-sequence" } as const;

        await tx
          .insert(conversationReadState)
          .values({ userId, conversationId })
          .onConflictDoNothing();
        const [stored] = await tx
          .select({ lastReadSequence: conversationReadState.lastReadSequence })
          .from(conversationReadState)
          .where(
            and(
              eq(conversationReadState.conversationId, conversationId),
              eq(conversationReadState.userId, userId),
            ),
          )
          .for("update");
        if (stored.lastReadSequence >= sequence) {
          return { status: "read", lastReadSequence: stored.lastReadSequence, advanced: false } as const;
        }

        await tx
          .update(conversationReadState)
          .set({ lastReadSequence: sequence, updatedAt: new Date() })
          .where(
            and(
              eq(conversationReadState.conversationId, conversationId),
              eq(conversationReadState.userId, userId),
            ),
          );
        await tx.insert(userSyncState).values({ userId }).onConflictDoNothing();
        const [state] = await tx
          .update(userSyncState)
          .set({ nextSequence: sql`${userSyncState.nextSequence} + 1` })
          .where(eq(userSyncState.userId, userId))
          .returning({ sequence: userSyncState.nextSequence });
        const [event] = await tx
          .insert(accountEvents)
          .values({
            userId,
            sequence: state.sequence,
            type: "conversation.read",
            conversationId,
            messageId: null,
            payload: { conversationId, lastReadSequence: sequence },
          })
          .returning();
        await tx.insert(outboxEvents).values({
          type: "conversation.read",
          messageId: null,
          accountEventId: event.id,
          payload: event.payload,
        });

        return { status: "read", lastReadSequence: sequence, advanced: true } as const;
      });
    },
  };
}

export const readStateService = createReadStateService();
export type ReadStateService = typeof readStateService;
