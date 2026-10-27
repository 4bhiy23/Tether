# Phase 3 multi-instance live delivery implementation plan

## Goal

Deliver committed messages live across the three chat instances while keeping PostgreSQL authoritative and preserving at-least-once recovery through `outbox_events`.

## Working constraints

- Preserve the approved design in `docs/superpowers/specs/2026-10-27-phase-3-live-delivery-design.md`.
- Keep the existing three-instance Docker/Nginx changes in scope.
- Use the installed `redis`, `@socket.io/redis-adapter`, Socket.IO, Drizzle, and Zod dependencies.
- Do not add a queue framework, retry library, shared-package abstraction, offline sync, or Phase 5 UI.
- Do not commit without separately approving the commit message.

## Task 1 — Add the pending-outbox index

Files:

- Modify `apps/chat/src/db/schema.ts`.
- Generate the next files under `apps/chat/drizzle/` and `apps/chat/drizzle/meta/`.

Steps:

1. Add a partial index on `outbox_events.created_at` where `published_at IS NULL`.
2. Generate rather than hand-author the migration and review the SQL and metadata together.
3. Apply the migration to the local PostgreSQL service.
4. Confirm existing Phase 2 transaction tests still pass.

Verification:

- The generated SQL contains one partial pending-outbox index.
- Re-running migrations is idempotent.
- `pnpm test` passes.

## Task 2 — Add the outbox envelope and batch publisher

Files:

- Add `apps/chat/src/modules/outbox/outbox.publisher.ts`.
- Add `apps/chat/src/modules/outbox/outbox.publisher.test.ts`.

Design:

- Define a versioned Zod schema for the internal Redis envelope.
- Keep the external publish operation dependency-injected as `(channel, payload) => Promise<number>`.
- Expose one function that claims and publishes a batch and one function that runs the sequential loop.
- Use the existing database factory/singleton pattern.

Steps:

1. In one transaction, select at most 50 unpublished rows ordered by creation time with `FOR UPDATE SKIP LOCKED`.
2. Load the associated message and account events from PostgreSQL rather than trusting the existing JSON payload shape.
3. Serialize one envelope containing version, outbox ID, message, and account events.
4. Await Redis `PUBLISH` and require a subscriber count greater than zero.
5. Set `published_at` only for successfully published rows.
6. Return the number processed so the loop can choose whether to wait.
7. Run immediately after productive batches, wait 500 ms when idle, and wait one second after errors.
8. Accept an `AbortSignal`; never overlap iterations or log message contents.

Tests:

- Redis/publisher failure rolls back `published_at`.
- A successful retry marks the row once.
- Two concurrent batch publishers claim different rows rather than publishing one row concurrently.
- An abort stops the idle loop.

## Task 3 — Configure Redis clients and local live-event dispatch

Files:

- Add `apps/chat/src/modules/realtime/realtime.ts`.
- Add `apps/chat/src/modules/realtime/realtime.test.ts` if parsing and dispatch need focused coverage.
- Modify `apps/chat/src/index.ts`.

Steps:

1. Create one Redis command/publisher client, one duplicate for the Socket.IO adapter subscriber, and one duplicate for the application outbox subscription.
2. Attach the installed Socket.IO Redis adapter.
3. Subscribe the application client to `tether:outbox` before starting the worker.
4. Parse every envelope with the shared Zod schema.
5. Emit `message.created` with the full message to the local `conversation:<conversationId>` room.
6. Emit each `account.event` to its local `user:<userId>` room.
7. Use Socket.IO's local-only flag so these emissions are not redistributed by the adapter.
8. Await all required Redis connections before accepting traffic; exit startup on failure.
9. Keep `/health` checking PostgreSQL and the command Redis client.
10. Start the outbox loop only after the application subscription is active.

Tests:

- Invalid or unsupported envelope versions are ignored and logged without content.
- One valid envelope emits once to the conversation room and once per account event to the correct user room.
- The subscriber path uses local-only emission.

## Task 4 — Add authenticated socket rooms and conversation authorization

Files:

- Add `apps/chat/src/modules/realtime/socket.controller.ts`.
- Add `apps/chat/src/modules/realtime/socket.controller.test.ts`.
- Modify `apps/chat/src/modules/chat/chat.service.ts`.
- Extend `apps/chat/src/modules/chat/chat.service.test.ts` only where a real membership query matters.
- Modify `apps/chat/src/index.ts` to register the controller.

Steps:

1. Add the smallest chat-service membership query that distinguishes missing conversation, forbidden user, and member.
2. Store both authenticated `sessionId` and `userId` in `socket.data`.
3. Join `session:<sessionId>` and `user:<userId>` immediately after connection.
4. Validate `conversation.join` and `conversation.leave` payloads with Zod.
5. Authorize every join against current PostgreSQL membership before joining the conversation room.
6. Return stable acknowledgement results and hide raw validation/database errors.
7. Allow a validated leave without a database query because it cannot grant access.
8. Preserve session-revocation disconnection behavior.

Tests:

- Authenticated sockets join both automatic rooms.
- Members can join a conversation room.
- Outsiders, missing conversations, malformed UUIDs, and database failures cannot join.
- Valid leave removes only the requesting socket.

## Task 5 — Add bounded client duplicate suppression

Files:

- Add `apps/web/lib/live-events.ts`.
- Add `apps/web/lib/live-events.test.ts`.
- Add a web test command using the same `tsx` test runner already used by the chat workspace, with `tsx` as a direct web development dependency.
- Modify the root test command so both chat and web tests run.

Steps:

1. Implement a small FIFO ID set capped at 1,000 entries.
2. Route `message.created` and message-bearing `account.event` through one message-ingestion function keyed by `message.id`.
3. Suppress repeated account events by event ID.
4. Keep the utility independent of React and IndexedDB so Phase 4 can replace storage without changing event semantics.

Tests:

- Conversation and account delivery of one message invokes the message callback once.
- Repeated account event IDs are ignored.
- IDs older than the 1,000-entry window are evicted.

## Task 6 — Prove Redis adapter and multi-instance delivery

Files:

- Add or extend a focused integration test under `apps/chat/src/modules/realtime/`.
- Modify `apps/chat/package.json` only if `socket.io-client` is needed as a direct test dependency.

Steps:

1. Start two Socket.IO servers using separate Redis adapter clients and ephemeral HTTP ports.
2. Connect a client to one server and join a test room.
3. Emit from the other server and assert the client receives the event once.
4. Close every socket, HTTP server, and Redis duplicate in `finally` blocks.
5. Keep this test independent from Better Auth; authentication and authorization remain covered by the socket-controller tests.

Verification:

- The test fails without the Redis adapter and passes with it.
- No Redis clients or server handles remain open after the test.

## Task 7 — Exercise pending-row recovery and the Docker topology

Files:

- Extend `apps/chat/src/modules/outbox/outbox.publisher.test.ts` for pending-row recovery.
- Review `Dockerfile`, `.dockerignore`, `compose.yaml`, and `nginx/nginx.conf` without adding deployment features.

Steps:

1. Create a committed message/outbox row while the publisher is stopped.
2. Start a publisher and assert the pending row is emitted and marked complete.
3. Simulate publication failure after the row is claimed and prove a later publisher retries it.
4. Build the root image.
5. Run the migration job and all three chat instances.
6. Validate Nginx configuration and `/health` through the proxy.
7. Verify a WebSocket handshake reaches a chat instance through Nginx.
8. Confirm all three chat containers remain healthy.

## Task 8 — Final verification and handoff

Commands/checks:

1. Run chat and web tests.
2. Run both TypeScript checks.
3. Run the Next.js production build.
4. Run `git diff --check`.
5. Run `docker compose config --quiet`.
6. Rebuild the chat image and start the three-instance topology.
7. Inspect container health and content-free error logs.
8. Confirm `.agents/`, `skills-lock.json`, secrets, local dependencies, and build output remain ignored.

Exit criteria mapping:

- Cross-instance recipient delivery: Tasks 3, 6, and 7.
- Multi-device account delivery: Tasks 3 and 4.
- Recovery after commit and publisher failure: Tasks 2 and 7.
- No duplicate client message: Task 5.

## Suggested commit boundaries

Commits are optional checkpoints and require explicit approval before creation:

1. `chore(docker): add three-instance chat topology`
2. `feat(chat): add multi-instance live delivery`
3. `test(chat): verify outbox recovery and event deduplication`
