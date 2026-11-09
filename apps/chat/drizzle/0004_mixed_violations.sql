CREATE TABLE "conversation_read_state" (
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_read_state_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id"),
	CONSTRAINT "conversation_read_state_sequence_check" CHECK ("conversation_read_state"."last_read_sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "account_events" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "account_event_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_read_state" ADD CONSTRAINT "conversation_read_state_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_read_state" ADD CONSTRAINT "conversation_read_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_account_event_id_account_events_id_fk" FOREIGN KEY ("account_event_id") REFERENCES "public"."account_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_account_event_unique" UNIQUE("account_event_id");--> statement-breakpoint
ALTER TABLE "account_events" ADD CONSTRAINT "account_events_type_reference_check" CHECK (("account_events"."type" = 'message.created' and "account_events"."message_id" is not null) or ("account_events"."type" = 'conversation.read' and "account_events"."message_id" is null));--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_type_reference_check" CHECK (("outbox_events"."type" = 'message.created' and "outbox_events"."message_id" is not null and "outbox_events"."account_event_id" is null) or ("outbox_events"."type" = 'conversation.read' and "outbox_events"."message_id" is null and "outbox_events"."account_event_id" is not null));--> statement-breakpoint
UPDATE "account_events" AS "event"
SET "payload" = jsonb_set(
	"event"."payload",
	'{conversation,members}',
	(
		SELECT jsonb_agg(
			jsonb_build_object('id', "user"."id", 'name', "user"."name", 'email', "user"."email")
			ORDER BY "user"."id"
		)
		FROM "conversation_members" AS "member"
		INNER JOIN "user" ON "user"."id" = "member"."user_id"
		WHERE "member"."conversation_id" = "event"."conversation_id"
	),
	true
)
WHERE "event"."type" = 'message.created'
	AND NOT ("event"."payload"->'conversation' ? 'members');
