# Tether implementation plan

## Scope and sequencing

This plan implements the selected architecture:

- Next.js web client.
- Hono HTTP API and Socket.IO chat service on long-lived Node.js instances.
- Better Auth with database-backed, revocable sessions.
- PostgreSQL as the durable source of truth.
- Redis for Socket.IO cross-instance routing and presence leases.
- A per-user, contiguous account-event sequence as the device sync token.

The build order proves durable message delivery before adding UI polish or ephemeral features. Metrics/dashboard work is intentionally deferred until the core chat path is reliable.

## Phase 0 — Repository and local runtime

### Deliver

- Complete the pnpm workspace and install dependencies.
- Start PostgreSQL and Redis through Docker Compose.
- Run the Next.js client and Hono/Socket.IO service locally.
- Add environment validation and a `/health` endpoint that checks process readiness.
- Add one command for tests and one command for database migrations.

### Exit criteria

- A new developer can clone the repository, copy `.env.example`, start local services, and open the web app.
- The web app can call the Hono health endpoint.
- Secrets are not committed.

## Phase 1 — Authentication and device sessions

### Deliver

- Mount Better Auth on Hono at `/api/auth/*`.
- Connect Better Auth to PostgreSQL and run its migrations.
- Build minimal sign-up, sign-in, sign-out, and current-session UI in Next.js.
- Validate the Better Auth session in Hono-protected routes and during the Socket.IO handshake.
- Treat each Better Auth session as a connected device/browser session.
- Implement session revocation and disconnect sockets belonging to a revoked session.

### Exit criteria

- The same account can sign in on two browsers.
- An unauthenticated HTTP request or socket connection is rejected.
- Revoking one browser session disconnects that browser without signing out the other.

## Phase 2 — Durable chat data and message writes

### Deliver

- Add migrations for conversations, memberships, messages, `user_sync_state`, `account_events`, and `outbox_events`.
- Support creating a direct conversation and a small group conversation.
- Implement server-side membership authorization.
- Implement the send-message command with `client_message_id` idempotency.
- In one PostgreSQL transaction: allocate the conversation sequence, insert the message, allocate per-user contiguous account events, and insert an outbox record.

### Exit criteria

- A user cannot send to a conversation they do not belong to.
- Retrying the same send from another server returns the original message and creates no duplicate.
- A successful message has exactly one ordered message row and the expected account events.
- Transaction failure leaves no partial message, event, or outbox row.

## Phase 3 — Multi-instance live delivery

### Deliver

- Configure Socket.IO's Redis adapter.
- Authenticate each socket and join it to `user:<userId>`.
- Add server-authorized `conversation:<conversationId>` join/leave behavior for an open chat view.
- Create the outbox publisher worker. It publishes committed outbox records and marks them complete safely.
- Emit full message events to active conversation rooms and account-change events to affected user rooms.
- Add duplicate suppression on the client by stable message/event ID.

### Exit criteria

- Two chat-server instances deliver a live message when sender and recipient use different instances.
- Two devices for one account receive appropriate account updates.
- A server crash after database commit but before publication is recovered by the outbox worker.
- A recipient receives no duplicate rendered message when both room and user events arrive.

## Phase 4 — Offline sync and local client state

### Deliver

- Add the `/sync` endpoint, taking the device's last processed per-user account sequence.
- Return ordered events, a next sync token, pagination, and `resetRequired` for expired tokens.
- Store messages, conversation metadata, and the sync token in IndexedDB.
- Store an event/message and advance the local sync token atomically.
- Implement socket-gap detection: a non-contiguous account sequence triggers `/sync` from the previous token.
- Add history pagination by per-conversation message sequence.
- Run sync on application launch, socket reconnect, gap detection, and a foreground safety interval.

### Exit criteria

- A recipient who is offline for multiple messages receives every missed message after reconnecting to any server.
- Restarting a chat server causes a reconnect and catch-up without a missing message.
- A client crash during sync is safe: repeating sync only produces deduplicated messages.
- A new device receives an initial snapshot and begins at the current account sequence.
- An expired token safely triggers a local rebuild from a fresh snapshot.

## Phase 5 — Core chat UX

### Deliver

- Conversation list with latest-message preview and unread count.
- Direct-message and group-chat screens.
- Optimistic message compose state, followed by server confirmation or error.
- Account-wide read pointer: mark messages read only when the conversation is visible.
- Typing events with rate limiting and local expiry.
- Presence leases in Redis, refreshed while connected and expiring within 30 seconds after a crash.

### Exit criteria

- A user sees correct unread counts after sync without messages being marked read merely because they downloaded.
- Reading a conversation on one device updates the user's other device.
- Typing indicators disappear after idle/disconnect even if `typing_stop` is lost.
- A crashed server's users become offline within 30 seconds unless another device is active.

## Phase 6 — Reliability, security, and operations

### Deliver

- Input validation, content-size limits, and rate limits for login, send, sync, and typing.
- Private Redis networking, TLS, auth credentials, and least-privilege Redis ACLs.
- Database backup/restore procedure and tested migrations.
- Graceful server shutdown: stop accepting new connections, drain/publish work, disconnect local sockets, and let clients reconnect.
- Integration tests using real PostgreSQL and Redis.
- A scripted resilience test that kills one chat instance during message traffic.

### Exit criteria

- Authorization checks cover HTTP endpoints and Socket.IO events.
- The resilience test proves no committed message is lost through an instance restart.
- Backup restoration is tested against a disposable environment.
- Load balancer health checks remove an unhealthy server.

## Phase 7 — Metrics and deployment

This phase is deferred until the core path above works end to end.

### Deliver

- Per-instance Prometheus metrics endpoint.
- Dashboards for active connections, message throughput, sync volume, outbox backlog, reconnects, and live delivery latency.
- Container image, production Compose/deployment configuration, and load balancer setup.
- Alerting for database/Redis reachability, outbox growth, elevated sync failures, and server health.

### Exit criteria

- Every instance has an observable connection count and message rate.
- A message can be traced from acceptance through database commit, outbox publish, and live socket write.
- Production runs at least two chat-service instances behind a load balancer.

## Tests required before first production release

| Scenario | Expected result |
|---|---|
| Sender and recipient on different instances | Recipient receives the live event. |
| Recipient offline | `/sync` returns all missed events after reconnect. |
| Sender retries after timeout | Exactly one stored message exists. |
| Server dies after message commit | Outbox/sync recovers delivery. |
| Server dies before message commit | No recipient observes a committed message. |
| Two devices on one account | Each device catches up from its own token. |
| Read on one device | The other device updates its account-wide read state. |
| Presence-owning instance crashes | Presence expires in 30 seconds or less. |
| Sync event arrives with a gap | Client syncs from its previous contiguous token. |
| User removed from group | Future sends, sync, history, typing, and room joins are denied. |

## Explicitly deferred

- Attachments and media processing.
- Push notifications.
- End-to-end encryption.
- Search.
- Voice/video calls.
- Large broadcast channels.
- Message edits/deletes and moderation.

These additions must be designed as separate phases because each changes data retention, sync semantics, and authorization behavior.
