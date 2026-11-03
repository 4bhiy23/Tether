# Phase 4 offline sync and local client state design

## Purpose

Phase 4 makes committed chat data recoverable on every browser after offline periods, socket gaps, reconnects, refreshes, and client crashes. PostgreSQL account events remain the durable change log; Socket.IO remains a low-latency hint. The web client persists its materialized chat state and last processed account sequence in IndexedDB.

The central invariant is:

> A device advances its account sync token only in the same IndexedDB transaction that stores every change represented by that token.

Read receipts, unread counts, typing, presence, and full chat screens remain Phase 5.

## Product rule

A conversation becomes visible to other devices only after its first message is successfully committed. Creating an empty conversation does not create an account event and does not make the conversation appear through sync in this or any future phase.

Every `message.created` account event carries the message and enough conversation metadata for a device to materialize the conversation when processing its first message.

## Scope

This phase includes:

- An authenticated incremental `/api/sync` endpoint.
- A consistent initial or replacement snapshot from the same endpoint.
- Ordered, bounded account-event pagination.
- Expired, missing, and future-token detection through `resetRequired`.
- Authorized message-history pagination by conversation sequence.
- Enriched `message.created` account-event payloads.
- Per-user IndexedDB storage for conversations, messages, and the sync token.
- Atomic event application and atomic snapshot replacement.
- Socket account-sequence gap detection.
- Sync on launch, reconnect, gap detection, foreground return, and a foreground safety interval.
- Offline and crash-replay tests using real PostgreSQL and IndexedDB-compatible transactions.
- One extension of the existing Docker integration harness for offline catch-up across instances.

This phase does not include:

- Conversation list or message-screen UI.
- Read pointers or unread counts.
- Typing or presence.
- Account-event retention or pruning jobs.
- A service worker, background sync, or push notifications.
- Container-kill resilience orchestration, which remains Phase 6.

## Durable event payload

The existing account-event type remains `message.created`. Its JSON payload changes from the stored message alone to:

```ts
{
  message: {
    id: string;
    conversationId: string;
    sequence: number;
    senderId: string;
    clientMessageId: string;
    content: string;
    createdAt: string;
  };
  conversation: {
    id: string;
    kind: "direct" | "group";
    title: string | null;
    memberIds: string[];
    createdAt: string;
  };
}
```

The send-message transaction already loads the conversation and members. It uses those rows to create the same canonical payload for every affected user's account event.

Phase 3 rows contain the message directly rather than this object. A custom data migration backfills existing `account_events.payload` rows before the new application code starts, deriving conversation metadata and sorted member IDs from the durable tables. This also makes any pending pre-Phase-4 outbox row publish the canonical shape. No column or constraint changes are required.

The outbox publisher continues loading stored messages and account events from PostgreSQL. Live `account.event` emissions therefore carry the enriched durable payload without a separate conversation lookup.

The conversation-room `message.created` event remains the stored message only. It can update an open conversation quickly but never advances an account sync token.

## Sync API

### Authentication

All sync requests use the current Better Auth session. The user ID is never accepted from a path, query, body, or client-controlled header.

### Initial or replacement snapshot

```http
GET /api/sync
```

Omitting `after` means the device has no trustworthy local cursor and requests a complete replacement snapshot.

The response is:

```ts
{
  mode: "snapshot";
  conversations: Array<{
    id: string;
    kind: "direct" | "group";
    title: string | null;
    memberIds: string[];
    createdAt: string;
    messages: Message[];
  }>;
  nextToken: number;
  resetRequired: false;
}
```

Only current memberships with at least one message are included. Each conversation contains its newest 50 messages in chronological order. Older messages are available through history pagination.

The snapshot and `nextToken` are read in one PostgreSQL read-only `REPEATABLE READ` transaction. This prevents a message from committing between the data read and token read and then being skipped permanently.

The server retrieves the latest message window without issuing one query per conversation.

### Incremental events

```http
GET /api/sync?after=42&limit=100
```

`after` is an exclusive, non-negative safe integer. `limit` defaults to 100 and must be between 1 and 100.

Supplying `limit` without `after` is invalid and returns `400`; snapshot sizing is fixed by the server contract.

The successful response is:

```ts
{
  mode: "events";
  events: AccountEvent[];
  nextToken: number;
  hasMore: boolean;
  resetRequired: false;
}
```

The server:

1. Reads `user_sync_state.next_sequence`, treating a missing row as sequence `0`.
2. Captures the current sequence and queries only the authenticated user's account events where `after < sequence <= capturedCurrentSequence`, ordered ascending, using `limit + 1` rows.
3. Verifies the first returned sequence is `after + 1` and every returned sequence is contiguous.
4. Returns at most `limit` rows.
5. Sets `nextToken` to the last returned sequence, or preserves `after` when the page is empty.
6. Sets `hasMore` when the extra row exists.

Concurrent messages append higher sequences. Events above the captured ceiling appear in a later loop and cannot change the meaning of the current page.

### Reset detection

The server returns:

```ts
{
  mode: "events";
  events: [];
  nextToken: number;
  hasMore: false;
  resetRequired: true;
}
```

when:

- `after` is greater than the user's current sequence.
- `after` is below the current sequence but the next contiguous event is unavailable.
- Any gap exists in the returned account-event page.

For a reset response, `nextToken` preserves the supplied `after` value. The client requests `GET /api/sync` without `after`. Phase 4 does not add an event-pruning job; continuity detection makes the reset path correct if rows are later pruned or removed.

Malformed cursors and limits return `400`. Missing authentication returns `401`. Raw validation and database errors are never returned.

## Conversation-history API

```http
GET /api/conversations/:id/messages?beforeSequence=150&limit=50
```

`beforeSequence` is an optional exclusive positive safe integer. `limit` defaults to 50 and must be between 1 and 100. Omitting `beforeSequence` requests the newest page.

The server includes current conversation membership in the history query itself, queries newest-first with `limit + 1`, and reverses the selected page before returning it in chronological order. Authorization and message selection therefore cannot be separated by a membership-removal race:

```ts
{
  messages: Message[];
  nextBeforeSequence: number | null;
  hasMore: boolean;
}
```

`nextBeforeSequence` is the oldest returned message sequence when another page exists. A missing conversation returns `404`; a nonmember receives `403`, matching the existing chat API.

History writes messages to IndexedDB idempotently and never changes the account sync token.

## Server structure

Sync code lives under `apps/chat/src/modules/sync/`:

- `sync.service.ts` owns snapshot and event-query transactions.
- `sync.controller.ts` authenticates, validates query input with Zod, calls the service, and maps stable responses.
- `sync.routes.ts` registers `/api/sync`.

History pagination stays in the existing chat module because it is conversation-scoped behavior. `index.ts` remains the explicit composition root.

The sync service follows the repository's existing dependency-injected factory, singleton export, and inferred service-type pattern.

## IndexedDB model

The web client uses the approved `idb` dependency over the browser's native IndexedDB implementation. Each account has an isolated database:

```text
tether-chat:<userId>
```

The database contains:

### `conversations`

- Key: conversation ID.
- Value: canonical conversation metadata.

### `messages`

- Key: message ID.
- Compound index: `[conversationId, sequence]`.
- Stable IDs make room delivery, account delivery, sync replay, and history overlap idempotent.

### `meta`

- Key/value records.
- Phase 4 stores `syncToken` as a non-negative integer.

Signing out closes the open database but does not delete it. Per-user database names prevent accidental cache mixing between normal account sessions; they are not a security boundary against same-origin script execution.

## Atomic local operations

### Apply an account-event page

One read-write transaction spans `conversations`, `messages`, and `meta`:

1. Read the stored token.
2. Verify it equals the page's expected starting token.
3. Materialize conversation metadata and messages idempotently from the events.
4. Store the response `nextToken`.
5. Commit.

If the token changed while the request was in flight, the transaction does not apply the stale page. The coordinator rereads the cursor and synchronizes again. This handles socket, sync, and multiple-tab races without an in-memory correctness lock.

If any write fails, IndexedDB rolls back the data and token together.

### Apply a live account event

For stored token `T` and incoming sequence `S`:

- `S <= T`: ignore the replay.
- `S === T + 1`: apply the event and advance the token in one transaction.
- `S > T + 1`: do not apply or advance; start sync from `T`.

### Store a room message

A conversation-room `message.created` event may upsert the message for immediate display. It does not create an account event or advance `syncToken`. A later account event or sync page safely upserts the same message ID.

### Replace a snapshot

Before requesting the snapshot, the coordinator captures the current local token, including the distinction between a missing record and stored token `0`. The complete snapshot is downloaded before opening the replacement transaction.

One transaction first verifies that the stored token still equals that captured value. It then clears and repopulates conversations and messages and writes `nextToken`. If another tab or live-event transaction advanced the cursor while the snapshot was downloading, replacement aborts and the coordinator rereads local state instead of overwriting newer data.

A failed download or transaction leaves the previous local cache and cursor intact. The client never clears local state before the replacement data is available.

After every initial or reset snapshot commits, the coordinator immediately runs incremental sync from the snapshot token. This catches a message committed after the snapshot's repeatable-read view but before local replacement.

## Sync coordinator

One coordinator owns synchronization for the authenticated user. It has at most one active sync loop; simultaneous triggers share or schedule the same work.

The coordinator:

1. Opens the user's IndexedDB database and records whether a `syncToken` record exists. Missing token means snapshot; stored token `0` means incremental sync from zero.
2. Registers socket listeners before initial synchronization but queues account events while initialization is in progress. Early live events cannot create a token and cause a new device to skip its snapshot.
3. Runs the initial snapshot or incremental sync.
4. After a snapshot, immediately catches up incrementally from its token before draining queued live events.
5. Pages until `hasMore` is false.
6. Handles `resetRequired` with snapshot download, compare-before-replace, and immediate incremental catch-up.
7. Rereads the local token when a concurrent transaction makes a response stale.
8. Drains queued live events through the normal sequence rules after initialization.
9. Aborts requests and removes listeners when the session changes or the component unmounts.

Synchronization is triggered by:

- Application launch for an authenticated session.
- Every Socket.IO connection or reconnection.
- A non-contiguous live account event.
- `visibilitychange` when the document becomes visible.
- A 60-second interval while the document is visible.

The interval is a safety net for silently missed socket notifications. It is stopped while the page is hidden.

A socket event that arrives during snapshot download may be represented both in the snapshot race window and in the queued live events. Immediate incremental catch-up plus sequence-based replay suppression makes either ordering safe.

## Client structure

The expected web files are:

- `lib/chat-types.ts` for the shared client-side API and event shapes when that avoids duplication.
- `lib/chat-store.ts` for IndexedDB schema and atomic operations.
- `lib/chat-sync.ts` for API paging and lifecycle coordination.
- `lib/live-events.ts` for sequence-aware event ingestion.
- `lib/live-socket.ts` for Socket.IO wiring.

The authenticated page starts and stops the coordinator. Phase 4 exposes durable primitives but does not build Phase 5 chat screens or a speculative state-management layer.

The existing 1,000-ID in-memory duplicate sets cease to be correctness-critical. IndexedDB keys and the durable account cursor provide persistent deduplication.

## Dependencies

- `idb` is a production dependency of `apps/web` and wraps real browser IndexedDB with promises and typed transactions.
- `fake-indexeddb` is a development-only dependency used by Node tests. It is not included in the production bundle.
- `zod` is a direct web dependency used to validate sync, snapshot, history, and live-event payloads before they can mutate IndexedDB or advance a token, following the repository's trust-boundary convention.

No state-management, retry, offline-database, or service-worker library is added.

The Phase 4 snapshot intentionally contains at most 50 messages for every nonempty conversation in one response. This is acceptable for the current small-account scope; paginated or staged snapshot transfer must replace it before production-scale account sizes.

## Failure behavior

### Device is offline

PostgreSQL account events accumulate. On reconnect, `/api/sync` returns every retained event after the device cursor in order.

### Socket reconnects to another instance

The new instance reads the same PostgreSQL event log. No process-local state is required for recovery.

### Socket event is duplicated

An event sequence at or below the persisted cursor is ignored. Stable event and message keys make replay harmless.

### Socket event has a gap

The event is not blindly applied. The coordinator synchronizes from the last persisted contiguous token.

### Browser crashes while applying a page

IndexedDB commits both data and token or neither. Restarting repeats the same page safely.

### Snapshot download or replacement fails

The old local cache and token remain available. A later trigger retries reset.

### Account events have been removed

The server detects non-contiguous sequence history and returns `resetRequired`; the client atomically rebuilds from a fresh snapshot.

## Testing

### Server controller tests

- Missing session returns `401`.
- Malformed, negative, unsafe, or oversized cursor and limit values return `400`.
- Invalid conversation IDs and history inputs are rejected before service calls.

### Real PostgreSQL tests

- Offline messages return every event in ascending sequence.
- Multiple pages have no gaps or duplicates.
- One user never receives another user's events.
- A current cursor returns an empty page without advancing it.
- A future cursor returns `resetRequired`.
- A deliberately removed event produces `resetRequired`.
- A snapshot includes only nonempty current memberships.
- Snapshot rows and token come from one repeatable-read view.
- Existing Phase 3 payload rows are backfilled to the canonical enriched shape.
- Every affected user's message event contains the same canonical message and conversation metadata with sorted member IDs.
- Outbox/live delivery preserves the canonical enriched payload.
- History pages are chronological, exclusive, non-overlapping, and membership-authorized.
- History returns `401` without a session, `403` for nonmembers, and `404` for missing conversations.
- A deterministic barrier between snapshot reads and a concurrent message commit proves the message appears either in the snapshot or the immediate incremental catch-up, never neither.

### IndexedDB tests

Node tests use the approved `fake-indexeddb` dependency to prove:

- A contiguous event atomically stores its conversation and message and advances the token.
- Forced transaction failure stores neither the new materialized data nor token.
- Reapplying a page creates no duplicate messages or conversations.
- Failed snapshot replacement preserves the previous cache and token.
- Successful replacement swaps cached data and token together.
- Separate user IDs open isolated databases.
- History storage does not change the account token.

### Client coordinator tests

- Duplicate events are ignored.
- A sequence gap triggers sync from the persisted token.
- Startup, reconnect, gap, visibility, and interval triggers coalesce into one sync loop.
- Hidden pages do not run the safety interval.
- Reset downloads complete before local replacement begins.
- An early live event cannot make a tokenless device skip its snapshot.
- A stale snapshot cannot replace a token advanced by another tab.
- An event committed during snapshot download is fetched by immediate post-snapshot sync.
- The complete reset flow handles `resetRequired`, snapshot replacement, and immediate incremental catch-up.

### Docker integration

Extend the existing integration harness rather than creating another topology:

- Pin the recipient's first socket to `chat-1`, disconnect it, send multiple messages through Nginx, then call sync directly against `chat-2` from the integration-test container and verify all events arrive once and in order. Keep a separate Nginx HTTP/WebSocket smoke check.
- Add a bounded host-side restart scenario: connect through Nginx, restart the serving chat container, send while the client is disconnected, then verify reconnect plus `/sync` catches up without a missing message.

The Phase 4 restart scenario proves the literal reconnect exit criterion. Killing an instance during sustained message traffic remains the broader Phase 6 resilience test.

## Exit criteria mapping

- Offline recipient catches up after reconnect: ordered PostgreSQL tests plus Docker offline catch-up.
- Restart and reconnect have no missing message: bounded container restart plus stateless sync through a different instance.
- Client crash during sync is safe: IndexedDB rollback and replay tests.
- New device receives current state and token: repeatable-read snapshot tests.
- Expired token rebuilds safely: server gap detection plus atomic snapshot replacement tests.

## Deferred decisions

- Account-event retention duration and pruning policy remain operational work.
- Read pointers and unread counts remain Phase 5 and do not reuse the sync token.
- Empty conversations never become visible through their own event.
- Background service workers and push notifications remain deferred.
- Container-kill resilience and load testing remain Phase 6.
