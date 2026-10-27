# Phase 3 multi-instance live delivery design

## Purpose

Phase 3 delivers committed messages live across multiple chat-server instances without weakening PostgreSQL durability. It adds cross-instance Socket.IO routing, authorized conversation rooms, an embedded outbox publisher, account-wide live events, and client duplicate suppression.

Offline recovery remains Phase 4. Redis Pub/Sub is a live transport, not the durable source of truth.

## Scope

This phase includes:

- Socket.IO's Redis adapter on every chat instance.
- Authenticated `session:<sessionId>` and `user:<userId>` rooms.
- Server-authorized `conversation:<conversationId>` joins and leaves.
- One embedded outbox publisher per chat instance.
- A dedicated Redis Pub/Sub channel for committed outbox envelopes.
- Full message events for open conversations.
- Per-user account events for all connected devices.
- Client suppression of duplicate message and account events.
- A partial PostgreSQL index for pending outbox rows.
- Multi-instance and failure-recovery tests.

This phase does not include offline sync, IndexedDB, history pagination, read receipts, typing indicators, presence, production deployment hardening, or a dedicated queue system.

## Runtime topology

The existing Docker Compose topology runs three identical chat instances behind Nginx. Every instance connects to the same PostgreSQL and Redis services.

Each chat instance owns:

1. An HTTP and Socket.IO server.
2. A Redis adapter publisher and subscriber pair.
3. A separate Redis subscriber for application outbox envelopes.
4. An embedded PostgreSQL outbox publisher loop.

No instance is the leader. PostgreSQL row locking distributes outbox work across all healthy instances.

## Socket authentication and rooms

The existing Better Auth handshake remains authoritative. A successful handshake stores `sessionId` and `userId` on `socket.data`.

On connection, the socket joins:

- `session:<sessionId>` so revoking one device disconnects only that session.
- `user:<userId>` so every connected device for the account receives account events.

The server accepts these client events:

### `conversation.join`

Input:

```json
{ "conversationId": "uuid" }
```

The server validates the payload, checks current PostgreSQL membership, and only then joins `conversation:<conversationId>`.

Acknowledgement outcomes are `joined`, `invalid`, `not-found`, `forbidden`, or `unavailable`. Raw validation and database errors are not exposed.

### `conversation.leave`

Input:

```json
{ "conversationId": "uuid" }
```

The server validates the payload and removes that socket from the room. Leaving does not require a database query because it grants no access.

Acknowledgement outcomes are `left` or `invalid`.

## Live event contract

### `message.created`

Sent to `conversation:<conversationId>`. The payload is the complete stored message, including its stable message ID and conversation sequence.

### `account.event`

Sent separately to each `user:<userId>` room. The payload is the stored account event, including its stable event ID, per-user sequence, type, message ID, and payload.

The sender may receive both event forms when the conversation is open. Clients must deduplicate them.

## Outbox publisher

Every instance starts one sequential publisher loop after PostgreSQL and all Redis clients are ready.

Each iteration:

1. Starts a PostgreSQL transaction.
2. Selects at most 50 rows where `published_at IS NULL`, ordered by creation time.
3. Locks them with `FOR UPDATE SKIP LOCKED`.
4. Loads the associated message and account events.
5. Serializes one versioned internal envelope per outbox row containing the outbox ID, message, and account events.
6. Awaits Redis `PUBLISH` to `tether:outbox`.
7. Sets `published_at` only after Redis accepts publication and reports at least one subscriber.
8. Commits the PostgreSQL transaction.

When no work exists, the loop waits 500 milliseconds. After a PostgreSQL or Redis error, it logs a content-free error, waits one second, and retries. Iterations never overlap.

A partial index on `outbox_events(created_at) WHERE published_at IS NULL` keeps idle polling and ordered claims cheap.

## Why publication uses a separate Redis channel

The installed Socket.IO Redis adapter invokes Redis publication without exposing a promise that confirms acceptance. Marking an outbox row complete immediately after `io.emit` could therefore lose live publication on an asynchronous Redis failure.

The outbox publisher instead awaits the existing Redis client's `PUBLISH` command. Each chat instance subscribes to `tether:outbox`, validates the versioned envelope with Zod, and converts it into local-only Socket.IO emissions. Local-only emission prevents the Socket.IO adapter from rebroadcasting the same envelope from every instance.

The publisher does not mark a row complete when Redis reports zero subscribers. Because each worker starts only after its own application subscription is active, zero subscribers indicates a connection or startup failure that must be retried.

The Socket.IO Redis adapter remains configured for cross-instance room operations and other Socket.IO broadcasts.

## Delivery guarantees

The publisher provides at-least-once live delivery:

- Crash before Redis publication: the transaction rolls back and another worker claims the row.
- Redis failure: the transaction rolls back and the row remains pending.
- Crash after publication but before commit: another worker republishes the row.
- Successful publication and commit: the row is complete.

Redis acceptance does not prove that a browser processed the event. Phase 4 account-event sync provides durable recovery for disconnected clients.

No maximum retry count or dead-letter state is added in this phase. Outbox rows are generated internally, and transient infrastructure failure is the expected retry case.

## Client duplicate suppression

The web client maintains FIFO-bounded in-memory sets containing the 1,000 most recently processed message IDs and account-event IDs.

Both `message.created` and message-bearing `account.event` payloads pass through one message ingestion function. A message ID already present is ignored. An account event ID already present is also ignored.

The sets are intentionally in-memory for Phase 3. Phase 4 replaces them with durable IndexedDB-backed state and a persisted account sequence.

## Startup and shutdown

The chat service does not accept traffic until its Redis adapter clients and application subscriber are connected. The outbox loop starts after those connections succeed.

The existing health endpoint checks PostgreSQL and Redis readiness. Startup failure terminates the process so Docker can restart it.

An `AbortController` stops new publisher iterations during shutdown. Full connection draining and graceful deployment behavior remain Phase 6.

## Testing

Tests cover:

- Membership authorization for conversation joins.
- Invalid socket payload rejection.
- User and session room assignment after authentication.
- Two workers cannot claim the same outbox row.
- Redis failure leaves `published_at` null.
- A later worker retries and marks the row complete.
- A pending row survives the originating instance stopping.
- Message events reach an open conversation on another server instance.
- Account events reach two device sockets for one user.
- Room and account delivery of one message produces one client message.
- Nginx continues proxying WebSocket connections across the three-instance topology.

PostgreSQL and Redis integration tests use the real local services where locking, publication, and failure semantics matter. Small socket authorization and client deduplication branches use focused unit tests.

## Deferred decisions

- PostgreSQL `LISTEN/NOTIFY` wakeups are unnecessary at three instances.
- BullMQ, RabbitMQ, Kafka, SQS, and CDC would add another delivery system without removing the transactional outbox.
- Attempt counters, exponential backoff, dead-letter handling, and outbox retention belong to operational hardening when observed failures justify them.
- Offline delivery and gap recovery remain Phase 4 responsibilities.
