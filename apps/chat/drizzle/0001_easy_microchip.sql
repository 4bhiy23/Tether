ALTER TABLE "conversations" ADD COLUMN "direct_key" text;--> statement-breakpoint
UPDATE "conversations" AS "conversation"
SET "direct_key" = (
	SELECT '[' || string_agg(to_json("member"."user_id")::text, ',' ORDER BY "member"."user_id") || ']'
	FROM "conversation_members" AS "member"
	WHERE "member"."conversation_id" = "conversation"."id"
)
WHERE "conversation"."kind" = 'direct';--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_direct_key_unique" UNIQUE("direct_key");
