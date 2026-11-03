import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db.js";
import {
  accountEvents,
  conversationMembers,
  conversations,
  messages,
  userSyncState,
} from "../../db/schema.js";

type Database = typeof db;
const snapshotMessageLimit = 50;

export function createSyncService(database: Database = db) {
  return {
    async getEvents(userId: string, after: number, limit: number) {
      return database.transaction(
        async (tx) => {
          const [state] = await tx
            .select({ sequence: userSyncState.nextSequence })
            .from(userSyncState)
            .where(eq(userSyncState.userId, userId))
            .limit(1);
          const currentSequence = state?.sequence ?? 0;
          const reset = () =>
            ({
              mode: "events",
              events: [],
              nextToken: after,
              hasMore: false,
              resetRequired: true,
            }) as const;

          if (after > currentSequence) return reset();

          const stored = await tx
            .select()
            .from(accountEvents)
            .where(
              and(
                eq(accountEvents.userId, userId),
                gt(accountEvents.sequence, after),
                lte(accountEvents.sequence, currentSequence),
              ),
            )
            .orderBy(asc(accountEvents.sequence))
            .limit(limit + 1);

          for (let index = 0; index < stored.length; index += 1) {
            if (stored[index].sequence !== after + index + 1) return reset();
          }
          if (after < currentSequence && stored.length === 0) return reset();

          const hasMore = stored.length > limit;
          const events = stored.slice(0, limit);
          return {
            mode: "events",
            events,
            nextToken: events.at(-1)?.sequence ?? after,
            hasMore,
            resetRequired: false,
          } as const;
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async getSnapshot(userId: string) {
      return database.transaction(
        async (tx) => {
          const visible = await tx
            .select({
              id: conversations.id,
              kind: conversations.kind,
              title: conversations.title,
              createdAt: conversations.createdAt,
            })
            .from(conversations)
            .innerJoin(
              conversationMembers,
              and(
                eq(conversationMembers.conversationId, conversations.id),
                eq(conversationMembers.userId, userId),
              ),
            )
            .where(
              sql`exists (
                select 1 from ${messages}
                where ${messages.conversationId} = ${conversations.id}
              )`,
            )
            .orderBy(asc(conversations.createdAt), asc(conversations.id));
          const conversationIds = visible.map(({ id }) => id);

          const members = conversationIds.length
            ? await tx
                .select({
                  conversationId: conversationMembers.conversationId,
                  userId: conversationMembers.userId,
                })
                .from(conversationMembers)
                .where(inArray(conversationMembers.conversationId, conversationIds))
                .orderBy(
                  asc(conversationMembers.conversationId),
                  asc(conversationMembers.userId),
                )
            : [];
          const recentMessages = conversationIds.length
            ? await tx.execute<{
                id: string;
                conversationId: string;
                sequence: number;
                senderId: string;
                clientMessageId: string;
                content: string;
                createdAt: Date;
              }>(sql`
                select
                  "recent"."id",
                  "recent"."conversation_id" as "conversationId",
                  "recent"."sequence"::float8 as "sequence",
                  "recent"."sender_id" as "senderId",
                  "recent"."client_message_id" as "clientMessageId",
                  "recent"."content",
                  "recent"."created_at" as "createdAt"
                from (
                  select
                    "message".*,
                    row_number() over (
                      partition by "message"."conversation_id"
                      order by "message"."sequence" desc
                    ) as "rank"
                  from "messages" as "message"
                  where "message"."conversation_id" in (
                    ${sql.join(conversationIds.map((id) => sql`${id}`), sql`, `)}
                  )
                ) as "recent"
                where "recent"."rank" <= ${snapshotMessageLimit}
                order by "recent"."conversation_id", "recent"."sequence"
              `)
            : { rows: [] };
          const [state] = await tx
            .select({ sequence: userSyncState.nextSequence })
            .from(userSyncState)
            .where(eq(userSyncState.userId, userId))
            .limit(1);

          return {
            mode: "snapshot",
            conversations: visible.map((conversation) => ({
              ...conversation,
              memberIds: members
                .filter(({ conversationId }) => conversationId === conversation.id)
                .map(({ userId: memberId }) => memberId),
              messages: recentMessages.rows.filter(
                ({ conversationId }) => conversationId === conversation.id,
              ),
            })),
            nextToken: state?.sequence ?? 0,
            resetRequired: false,
          } as const;
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}

export const syncService = createSyncService();
export type SyncService = typeof syncService;
