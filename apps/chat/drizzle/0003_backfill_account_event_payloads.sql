UPDATE "account_events" AS "event"
SET "payload" = jsonb_build_object(
	'message', jsonb_build_object(
		'id', "message"."id",
		'conversationId', "message"."conversation_id",
		'sequence', "message"."sequence",
		'senderId', "message"."sender_id",
		'clientMessageId', "message"."client_message_id",
		'content', "message"."content",
		'createdAt', "message"."created_at"
	),
	'conversation', jsonb_build_object(
		'id', "conversation"."id",
		'kind', "conversation"."kind",
		'title', "conversation"."title",
		'memberIds', (
			SELECT jsonb_agg("member"."user_id" ORDER BY "member"."user_id")
			FROM "conversation_members" AS "member"
			WHERE "member"."conversation_id" = "conversation"."id"
		),
		'createdAt', "conversation"."created_at"
	)
)
FROM "messages" AS "message"
INNER JOIN "conversations" AS "conversation"
	ON "conversation"."id" = "message"."conversation_id"
WHERE "event"."message_id" = "message"."id"
	AND NOT (
		jsonb_typeof("event"."payload") = 'object'
		AND "event"."payload" ? 'message'
		AND "event"."payload" ? 'conversation'
	);
