# Phase 5 core chat UX design

## Purpose

Phase 5 turns the durable messaging and offline-sync foundations into the first complete chat experience. Users can find people by exact email, start direct or group conversations, exchange messages with optimistic feedback, see correct unread counts on every device, and receive bounded typing and presence signals across chat-server instances.

PostgreSQL remains authoritative for messages, memberships, account sequences, and read state. Redis carries only ephemeral typing and presence data. IndexedDB remains the browser's durable materialized view.

The central read-state invariant is:

> Advancing a read pointer, allocating its account sequence, inserting its account event, and inserting its outbox record happen in one PostgreSQL transaction; applying that event and advancing the browser sync token happen in one IndexedDB transaction.

## Approved product rules

- A conversation appears in the conversation list only after its first message is committed. Creating or abandoning an empty conversation never makes it visible through sync.
- Users find recipients by normalized exact email only. There is no partial search or browsable user directory.
- Read state drives only the current user's unread counts and synchronization between that user's devices. Phase 5 does not expose sender-visible read receipts.
- The authenticated desktop experience uses the approved warm-neutral, compact two-pane layout. Mobile uses a list-to-chat flow with a back action rather than a permanent sidebar.
- Typing and presence are hints. Their absence must never block durable messaging.

## Scope

This phase includes:

- A conversation list ordered by latest activity, with latest-message previews and unread counts.
- Direct-message and group-chat views with history pagination.
- Exact-email user lookup and new-conversation composition.
- Optimistic sending with confirmation, visible failure, and idempotent retry.
- A durable, monotonic read pointer per user and conversation.
- Cross-device read updates through account events, outbox publication, and sync.
- Authorized, rate-limited typing events with client-side expiry.
- Redis presence leases that support multiple devices and expire within 30 seconds after a crash.
- Responsive desktop and mobile chat navigation.

This phase does not include:

- Sender-visible read receipts.
- Partial-email search, contact suggestions, or a global presence directory.
- Durable unsent drafts or an automatic offline-send queue.
- Attachments, reactions, message editing, deletion, or notifications.
- Last-seen timestamps, away states, or presence history.
- Virtualized message lists or a new frontend state-management library.
- General login, send, or sync rate limiting, which remains Phase 6. Typing receives the narrow limiter required by this phase.

## Visual direction

The authenticated application replaces the current signed-in placeholder with one chat shell:

- A compact conversation rail with the Tether wordmark, new-chat action, local conversation filter, latest-message previews, unread badges, and the signed-in account.
- A focused active-chat pane with participant identity, active-conversation presence, chronological messages, typing text, and a single composer.
- Warm off-white surfaces, graphite text, a restrained green accent, fine borders, and dense spacing. The interface should read as a communication tool, not a grid of dashboard cards.
- Message delivery states appear inline and do not change layout substantially.
- On narrow screens, the rail and active chat are mutually exclusive. Selecting a conversation opens it; a back button returns to the list.

The design uses semantic controls, visible labels, keyboard-accessible navigation, focus styles, and live status regions for send failures, connection state, and typing text.

## User discovery and conversation creation

### Exact-email lookup

An authenticated endpoint accepts one email in a JSON body. The controller validates the body with Zod and normalizes the value by trimming surrounding whitespace and lowercasing it. The service performs equality comparison against the normalized stored email. It never performs prefix, substring, fuzzy, or case-sensitive display-text search.

The successful result contains only:

```ts
{
  id: string;
  name: string;
  email: string;
}
```

Missing users receive a stable not-found response. The endpoint never returns alternative or similar accounts. The current user cannot add the same member twice; duplicate normalized emails are rejected in the client and server inputs.

Better Auth continues to own the `user` table. Chat code reads only the required profile columns and does not add that table to the application schema.

### New direct conversation

The new-chat form resolves one exact recipient email, then calls the existing create-conversation command with the resolved user ID. The direct-conversation uniqueness invariant continues to return the existing direct conversation when one already exists.

The client opens the resulting conversation as a draft view. It does not insert it into the durable visible-conversation projection. If the user leaves without sending, the empty database conversation stays hidden. On first successful send, the normal `message.created` account event materializes it on every member's device.

### New group conversation

The form requires a title and at least two other members, resolving each exact email explicitly before creation. It uses the existing group command after every member is resolved. Unresolved addresses remain visible form errors and are never silently omitted.

An abandoned empty group may remain in PostgreSQL but stays absent from snapshots, events, and conversation lists. Cleanup of abandoned empty groups is not part of Phase 5.

## Participant profiles

Conversation API shapes gain the minimum member profile data needed by the UI:

```ts
type ConversationMember = {
  id: string;
  name: string;
  email: string;
};
```

Conversation metadata retains sorted `memberIds` for existing invariants and adds sorted `members` for presentation. Direct-chat titles and avatars derive from the other member. Group chats use their stored title and member names.

Snapshots and newly created `message.created` payloads include member profiles. A data migration enriches existing account-event conversation payloads so an incremental client cannot receive the old shape after the new runtime starts. Profile changes after event creation do not rewrite historical events; a fresh snapshot reflects current profiles.

## Durable read state

### Schema

Add `conversation_read_state` to `apps/chat/src/db/schema.ts`:

- `user_id` and `conversation_id` form the primary key.
- `last_read_sequence` is a non-negative bigint stored as a safe JavaScript number.
- `updated_at` records the latest advancement.
- Foreign keys preserve user and conversation integrity, with conversation deletion cascading.

The row means every message at or below `last_read_sequence` is read for that user. Missing state is equivalent to sequence `0`.

### Mark-read command

```http
PUT /api/conversations/:id/read
Content-Type: application/json

{ "sequence": 42 }
```

The controller authenticates, validates the UUID and positive safe integer, and maps stable errors. The service transaction:

1. Verifies current membership at the operation boundary.
2. Verifies the target sequence belongs to an existing message in that conversation and is not beyond the conversation's committed sequence.
3. Locks or creates the user's read-state row.
4. Returns without an event when the stored pointer is already equal or higher.
5. Advances the pointer.
6. Allocates exactly one next account sequence for that user.
7. Inserts one `conversation.read` account event.
8. Inserts one outbox record for that account event.

The transaction returns the canonical pointer. Any failure rolls back the pointer, account event, sequence allocation, and outbox record together.

Concurrent devices cannot move the pointer backward or allocate duplicate advancements because the read-state row and per-user sync-state row serialize updates.

### Account and outbox events

`account_events` becomes a discriminated durable stream:

```ts
type MessageCreatedEvent = {
  type: "message.created";
  messageId: string;
  payload: { message: Message; conversation: Conversation };
};

type ConversationReadEvent = {
  type: "conversation.read";
  messageId: null;
  payload: {
    conversationId: string;
    lastReadSequence: number;
  };
};
```

The existing non-null message-only constraint and user/message uniqueness rule are replaced with type-aware checks and a partial uniqueness rule for `message.created`. Existing message events remain unchanged.

`outbox_events` gains the minimum nullable account-event reference required for `conversation.read`. Type-aware checks require message outbox rows to reference a message and read outbox rows to reference one account event. The publisher emits a validated discriminated envelope and marks each row published only after Redis accepts it. Existing message publication continues to send conversation-room and per-user account events; a read publication sends only the user-scoped account event.

### Sync

Snapshot conversations include `lastReadSequence`. Incremental pages contain both account-event variants in the same contiguous per-user sequence. A read event is visible only to the account whose pointer advanced, which updates all of that account's devices without exposing the receipt to other members.

Unread count is:

```text
max(0, latestMessageSequence - lastReadSequence)
```

Downloading, synchronizing, receiving, or rendering a message does not change the pointer.

## IndexedDB projection

The per-user database adds a `readState` object store keyed by conversation ID. Its value contains the conversation ID and last read sequence.

Atomic account-event application spans `conversations`, `messages`, `readState`, and `meta`:

- `message.created` upserts its conversation and message.
- `conversation.read` upserts the monotonic read pointer.
- The sync token advances only after the event's projection write is part of the same transaction.

Snapshot replacement clears and repopulates conversations, messages, and read state before writing the snapshot token in the same transaction. Reset, replay, and stale-snapshot protections from Phase 4 remain unchanged.

Conversation-list projections are derived from IndexedDB rather than stored as a second source of truth. The latest local message supplies the preview and activity order. Conversation sequence plus read state supplies the unread count.

## Client runtime boundary

A small chat client composes the existing store, sync coordinator, and Socket.IO connection. It exposes query methods and uses the platform `EventTarget` API to announce local projection changes. React hooks subscribe and reload only the relevant conversation or list projection.

No Redux-like state library is added. IndexedDB owns confirmed durable state; React owns only navigation, forms, typing text, presence snapshots, and optimistic messages.

The runtime closes its database, timers, observers, socket listeners, and abort controller when the authenticated session changes or signs out.

## Optimistic sending

The browser generates one UUID `clientMessageId` when the user submits non-empty content. It immediately appends an in-memory optimistic message with status `sending`.

On success:

- The canonical response is written to IndexedDB.
- The optimistic entry is removed by matching `clientMessageId`.
- Later room and account events idempotently upsert the same message ID.

On network or server failure:

- The entry remains visible with status `failed` and an accessible retry action.
- Retrying changes the status to `sending` and reuses the exact same `clientMessageId` and content.
- A response lost after commit therefore resolves to the original message through existing server idempotency.

Pending and failed messages remain in memory. Refreshing the page discards them; Phase 5 does not create a durable offline-send queue.

## Read observation

Message elements carry their conversation sequence. One `IntersectionObserver` tracks the highest actually visible confirmed message in the active conversation.

The client proposes a mark-read advancement only when:

- The chat is the active mobile or desktop pane.
- The document visibility state is `visible`.
- The message intersects the scroll viewport.
- Its sequence is above the locally confirmed read pointer.

Advancements are coalesced to the highest observed sequence. At most one request is active; a higher pending sequence runs afterward. Failure retains the desired maximum for retry on the next visibility, message, or connection trigger. Optimistic messages have no server sequence and are never read-pointer targets.

This avoids using scroll-to-bottom commands or treating a downloaded message as read.

## History and navigation

Selecting a conversation joins its authorized Socket.IO room, loads its IndexedDB messages, and fetches older history when the user requests or reaches the top boundary. Leaving changes rooms and clears active typing state.

The newest confirmed message is the initial scroll anchor. Loading older history preserves the visible anchor instead of forcing the user to the bottom. Automatic bottom following occurs only when the user is already near the newest message or sends a message.

On mobile, selecting a conversation replaces the list pane. Browser history or the explicit back action returns to the list without closing the authenticated chat runtime.

## Typing protocol

### Client

While the active composer contains non-whitespace text, the client emits `typing.start` immediately and every two seconds. It emits `typing.stop` on send, clear, blur, active-conversation change, and normal teardown.

Receiving clients store typing participants in memory with five-second deadlines. Each start pulse replaces that participant's deadline. Stop removes it immediately. Expiry removes it even when a stop event, disconnect event, or server process is lost.

Direct chats render `<name> is typing`. Groups list at most two names, then use `and others`. The text is exposed through a polite live region without announcing every keepalive pulse.

### Server

Socket payloads use Zod and contain only `conversationId`. Identity always comes from the authenticated socket. The server accepts typing only when the socket is already in the corresponding conversation room, which was joined after database-backed membership authorization.

A per-socket, per-conversation limiter accepts at most one start pulse per second. Invalid, unauthorized, or over-limit pulses are not broadcast. Accepted events are emitted to the conversation room excluding the sender; Socket.IO's Redis adapter carries them across instances.

Typing is never stored in PostgreSQL, the account log, the outbox, or IndexedDB.

## Presence leases

Redis stores one sorted set per user. Each connected socket ID is a member; its score is the lease expiry timestamp.

- Connection writes a lease expiring 30 seconds in the future.
- The serving process refreshes its local sockets every 10 seconds.
- Normal disconnect removes only that socket member.
- Queries delete or ignore scores at or below the current time.
- The sorted-set key receives a bounded TTL so users who never reconnect do not leave permanent empty keys.

A user is online when at least one socket member has a score in the future. Multiple tabs, devices, and server instances therefore compose correctly. A crashed server stops refreshing only its sockets; those leases become invalid within 30 seconds while another active device keeps the user online.

The active chat polls an authorized socket presence command every 10 seconds. The command accepts a conversation ID, verifies current membership, obtains that conversation's members from PostgreSQL, and returns their current booleans. It never accepts arbitrary user IDs or exposes a global directory.

Inactive conversation rows may show the last presence result learned during the current session, but only the active chat is refreshed continuously. Presence failures remove or omit status rather than preserving an online claim indefinitely.

Presence uses the existing Redis dependency. It does not add a queue, worker, or production package.

## Server structure

Feature code follows the established module pattern:

- `modules/directory/` owns exact-email lookup controller, route, service, and tests.
- `modules/read-state/` owns mark-read controller, route, transaction service, and tests.
- `modules/presence/` owns Redis leases, authorized status queries, socket lifecycle, and tests.
- Typing socket behavior remains beside the realtime socket controller, split into a focused module if the controller would otherwise mix membership, presence, and typing responsibilities.
- Existing chat, sync, outbox, and realtime modules gain only the new behavior they own.
- `index.ts` remains the explicit composition and lifecycle root.

Application runtime reads Redis and database configuration only through validated `env.ts`. The application schema remains one `db/schema.ts` file.

## Client structure

The expected client boundaries are:

- `lib/chat-client.ts` composes IndexedDB, sync, socket events, optimistic sends, read coordination, and subscriptions.
- `lib/chat-store.ts` owns the upgraded IndexedDB schema and projections.
- `lib/chat-types.ts` owns validated discriminated API/event shapes.
- Focused hooks expose conversation-list and active-chat state.
- Small components render the conversation rail, new-chat form, message thread, composer, presence, and typing state.
- The authenticated page composes the responsive shell and retains authentication behavior.

Components remain organized around user-visible responsibilities. Phase 5 does not introduce a generic design system or speculative component library.

## Error handling

- External HTTP, socket, and public runtime data are validated before use.
- Raw Zod, PostgreSQL, Redis, and Socket.IO errors are not returned to clients.
- A sync failure leaves the existing IndexedDB projection and token intact.
- A failed read update leaves the durable pointer unchanged and retries its highest desired value later.
- Failed typing or presence operations degrade to no ephemeral indicator.
- A failed send remains visible and retryable with the original idempotency key.
- Membership denial prevents history, read advancement, room join, typing, and presence lookup.

## Migrations

One generated migration and its metadata add read state and generalize event/outbox constraints. Any payload backfill required for participant profiles is included as reviewed custom SQL in the same phase migration sequence or a subsequent generated migration when the schema tool requires separation.

Applied migrations are never edited. Generated SQL, custom data SQL, metadata snapshots, runtime schemas, and migration tests are reviewed as coupled outputs.

## Verification

### PostgreSQL integration

- Membership is required to advance a read pointer.
- Read pointers advance monotonically under concurrent devices.
- A successful advancement creates exactly one ordered account event and one pending outbox row.
- A repeated or lower sequence creates neither.
- Transaction failure leaves no partial pointer, sequence, event, or outbox change.
- Snapshot and incremental sync return read state and both event variants correctly.
- Existing message idempotency and outbox publication remain unchanged.
- Exact-email lookup returns only the exact normalized account.

### Redis and Socket.IO integration

- Typing crosses instances only for authorized room members and is rate-limited.
- Local expiry removes typing after a lost stop or disconnect.
- Multiple sockets keep a user online until every lease is absent or expired.
- Stopping one chat instance causes only its socket leases to expire within 30 seconds.
- Another active device preserves online state.

### IndexedDB and client logic

- Applying read events and advancing the sync token is atomic.
- Snapshot replacement includes read state and rollback safety.
- Unread counts do not change when messages merely download.
- Visible-message observation advances only to the highest visible confirmed sequence.
- Optimistic confirmation removes the matching pending item.
- Failure and retry reuse the same `clientMessageId`.
- Typing deadlines and presence refresh state expire locally.

### UI and repository checks

- Node tests cover extracted view-model and coordinator behavior without adding a React testing framework.
- The web production build verifies the real Next.js boundary.
- Browser smoke testing covers sign-in, exact-email creation, first-message visibility, direct and group navigation, optimistic failure/retry, unread clearing, typing, presence, and the mobile list/chat transition.
- Existing chat tests, integration tests, TypeScript checks, Compose validation, and `git diff --check` remain green.

## Dependencies

Phase 5 adds no production dependency. It uses the existing PostgreSQL, Redis, Socket.IO, Zod, `idb`, React, and Next.js packages plus platform `EventTarget`, `IntersectionObserver`, `crypto.randomUUID`, and visibility APIs.

No frontend test dependency is added. If implementation exposes a behavior that cannot be verified through the existing Node tests, production build, and browser harness, that dependency choice must be presented to the user before installation.
