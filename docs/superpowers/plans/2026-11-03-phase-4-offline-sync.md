# Phase 4 offline sync and local client state implementation plan

## Goal

Make every browser recover committed chat data after offline periods, socket gaps, refreshes, reconnects, server restarts, and client crashes while keeping PostgreSQL account events authoritative and advancing each device cursor only with its durable local writes.

## Working constraints

- Preserve the approved design in `docs/superpowers/specs/2026-11-03-phase-4-offline-sync-design.md`.
- A conversation remains invisible until its first message commits; do not add `conversation.created` events.
- Keep read receipts, unread counts, typing, presence, and chat screens out of Phase 4.
- Use the approved `idb`, `fake-indexeddb`, and web `zod` dependencies; add no state manager, retry framework, service worker, or offline database framework.
- Keep runtime server configuration in `env.ts` and preserve existing module factories and singleton exports.
- Do not split `db/schema.ts`.
- Do not commit without separately approving the commit message.

## Parallel execution boundaries

After this plan is approved, subagents may work in parallel only on non-overlapping areas:

- Server agent: event payload migration, sync module, and history API.
- Client-storage agent: client schemas, IndexedDB store, and their tests; it does not edit dependency manifests or the lockfile.
- Integration-test agent: extend or add integration test scripts after the server contract exists; it reports required Compose or root-script changes instead of editing shared files.
- Main agent: dependency manifests and lockfile, Compose and root scripts, sync coordinator, Socket.IO lifecycle, page wiring, cross-area review, and final verification.

Agents must not edit the same files concurrently. The main agent reviews every diff and resolves shared-file changes such as `package.json`, `pnpm-lock.yaml`, `index.ts`, and `compose.yaml`.

## Task 1 — Add approved web dependencies and runtime schemas

Files:

- Modify `apps/web/package.json`.
- Modify `pnpm-lock.yaml` through pnpm.
- Add `apps/web/lib/chat-types.ts`.
- Add `apps/web/lib/chat-types.test.ts`.

Steps:

1. Add `idb` and `zod` as direct web runtime dependencies.
2. Add `fake-indexeddb` as a web development dependency.
3. Define Zod schemas for messages, visible conversation metadata, enriched account events, event-page responses, snapshot responses, and history responses.
4. Infer TypeScript types from the schemas instead of duplicating interfaces.
5. Reject malformed HTTP and Socket.IO payloads before they reach IndexedDB or advance a token.
6. Keep schemas focused on external payloads; do not add Zod to internal typed objects that do not cross a trust boundary.

Tests:

- Valid snapshot, event-page, history, and live payloads parse.
- Invalid sequences, UUIDs, event types, or nested payload shapes fail.
- `resetRequired` responses preserve the supplied cursor shape.

## Task 2 — Enrich durable account events and backfill Phase 3 rows

Files:

- Modify `apps/chat/src/modules/chat/chat.service.ts`.
- Extend `apps/chat/src/modules/chat/chat.service.test.ts`.
- Add `apps/chat/src/modules/chat/account-event-payload.migration.test.ts`.
- Generate a custom migration and metadata under `apps/chat/drizzle/`.

Steps:

1. Select the complete conversation metadata while holding the existing conversation lock.
2. Reuse the already loaded, sorted membership rows.
3. Store `{ message, conversation }` as every affected user's `message.created` payload.
4. Keep message insertion, event allocation, enriched payload insertion, and outbox insertion in the existing PostgreSQL transaction.
5. Generate a new custom migration rather than editing an applied migration.
6. Backfill old message-only JSONB payloads using the durable message, conversation, and current sorted membership rows.
7. Leave already enriched rows unchanged so the migration is safe to re-run through normal migration tracking.
8. Review the migration SQL and generated metadata together.

Tests:

- Every member receives the same message and conversation metadata.
- `memberIds` are sorted and complete.
- Transaction rollback still removes message, events, and outbox together.
- Existing idempotent replay returns the original message without another event.
- The outbox publisher preserves the enriched payload.
- A migration test seeds one old message-only payload and one already-enriched payload, executes the idempotent custom migration SQL in a rolled-back transaction, and proves the old row is canonicalized with sorted members while the enriched row is unchanged.

## Task 3 — Add the authenticated sync module

Files:

- Add `apps/chat/src/modules/sync/sync.service.ts`.
- Add `apps/chat/src/modules/sync/sync.service.test.ts`.
- Add `apps/chat/src/modules/sync/sync.controller.ts`.
- Add `apps/chat/src/modules/sync/sync.controller.test.ts`.
- Add `apps/chat/src/modules/sync/sync.routes.ts`.
- Modify `apps/chat/src/index.ts`.

Steps:

1. Preserve the existing `createX(defaultDependency)` factory, singleton, and inferred service type pattern.
2. Authenticate through `DeviceSessionService`; never accept a user ID from the client.
3. Validate `after` as a non-negative safe integer and `limit` as `1..100`; reject `limit` when `after` is absent.
4. Treat absent `user_sync_state` as current sequence zero.
5. For incremental sync, capture the current sequence and query `after < sequence <= capturedCurrentSequence`, ordered ascending, with `limit + 1`.
6. Verify the returned sequence is contiguous from `after + 1`.
7. Preserve `after` as `nextToken` for empty and `resetRequired` responses.
8. Return `resetRequired` for a future cursor or missing sequence.
9. For a snapshot, use one read-only `REPEATABLE READ` transaction for visible conversations, newest 50 messages per conversation, sorted members, and current token.
10. Exclude conversations with no messages and avoid one query per conversation.
11. Register `/api/sync` in the composition root.
12. Return stable `400` and `401` responses without leaking validation or database errors.

Tests:

- Authentication and query-validation branches.
- Ordered pages with correct exclusive cursor, `nextToken`, and `hasMore`.
- User isolation.
- Current cursor returns an empty page without advancing.
- Future cursor and a deliberately removed event return `resetRequired`.
- Concurrent events above the captured ceiling are deferred to a later request.
- Snapshot includes only nonempty current memberships and newest 50 messages in chronological order.
- A controlled database barrier proves a concurrent message is present either in the snapshot or immediate subsequent sync, never missing from both.

## Task 4 — Add authorized history pagination

Files:

- Modify `apps/chat/src/modules/chat/chat.service.ts`.
- Modify `apps/chat/src/modules/chat/chat.controller.ts`.
- Modify `apps/chat/src/modules/chat/chat.routes.ts`.
- Extend the existing chat service and controller tests.

Steps:

1. Register `GET /api/conversations/:id/messages`.
2. Validate the conversation UUID, optional exclusive positive `beforeSequence`, and limit `1..100` with default 50.
3. Keep membership inside the message-selection query or the same transaction so authorization cannot race removal.
4. Query newest-first using `limit + 1`, then return the page chronologically.
5. Return `nextBeforeSequence` only when another page exists.
6. Preserve existing `404` for missing conversation and `403` for nonmembers.

Tests:

- Newest and older pages are chronological, exclusive, non-overlapping, and complete.
- Missing session returns `401`.
- Nonmember returns `403`; missing conversation returns `404`.
- Invalid input never calls the service.

## Task 5 — Add the per-user IndexedDB store

Files:

- Add `apps/web/lib/chat-store.ts`.
- Add `apps/web/lib/chat-store.test.ts`.

Steps:

1. Open `tether-chat:<userId>` with `idb`.
2. Add `conversations`, `messages`, and `meta` stores.
3. Add the compound message index `[conversationId, sequence]`.
4. Represent a missing token distinctly from stored token zero.
5. Implement atomic event-page application across all three stores with an expected-token compare.
6. Implement a single live-event application using the same sequence and transaction rules.
7. Upsert room messages without changing the token.
8. Implement compare-before-replace snapshot replacement that aborts when the local token changed during download.
9. Store history messages without changing the token.
10. Close, but do not delete, the database on sign-out.
11. Add `shortcut: snapshots are replaced in one transaction, paginate or stage them before production-scale accounts` beside the replacement boundary.

Tests with `fake-indexeddb`:

- Contiguous events atomically store conversation/message and advance the token.
- Forced failure commits neither materialized data nor token.
- Duplicate pages and overlapping history create no duplicate messages.
- Missing token and stored zero remain distinct.
- Failed or stale snapshot replacement preserves the old cache and token.
- Successful replacement swaps data and token together.
- Separate user IDs cannot accidentally mix caches.
- Room and history writes never advance the account token.

## Task 6 — Build the sync coordinator and durable live-event handling

Files:

- Add `apps/web/lib/chat-sync.ts`.
- Add `apps/web/lib/chat-sync.test.ts`.
- Modify `apps/web/lib/live-events.ts` and its tests.
- Modify `apps/web/lib/live-socket.ts`.
- Modify `apps/web/app/page.tsx`.

Steps:

1. Open the user database and decide snapshot versus incremental initialization from token presence, not token truthiness.
2. Register socket listeners before initialization but queue account events until initialization finishes.
3. Allow only one active sync loop; simultaneous triggers share or schedule the same work.
4. Parse every HTTP and Socket.IO payload with the Task 1 schemas before storage.
5. Page incremental sync until `hasMore` is false.
6. On `resetRequired`, download a snapshot, compare-before-replace, then immediately sync from the snapshot token.
7. After every initial snapshot, immediately sync from its token before draining queued live events.
8. Apply live sequences at or below the token as replays, exactly next as atomic events, and gaps as sync triggers.
9. Keep room messages as idempotent fast-path writes that never advance the token.
10. Trigger synchronization on authenticated launch, every socket connection/reconnection, account-event gap, visible `visibilitychange`, and a 60-second interval while visible.
11. Abort fetches, remove listeners, stop timers, disconnect the socket, and close the database when the session changes or unmounts.
12. Keep cached data on sign-out and do not build Phase 5 UI.

Tests:

- Tokenless initialization cannot be skipped by an early live event.
- Stored zero initializes incrementally.
- Duplicate live events are ignored; contiguous events advance; gaps synchronize from the previous token.
- Startup, reconnect, gap, visibility, and interval triggers coalesce.
- Hidden pages do not poll.
- Stale pages and snapshots reread local state rather than overwriting it.
- Snapshot replacement is always followed by incremental catch-up.
- A message committed during snapshot download is caught before initialization completes.
- The complete reset flow converges from `resetRequired` to snapshot to incremental state.
- Cleanup aborts and closes every owned resource.

## Task 7 — Extend multi-instance offline and restart coverage

Files:

- Extend `apps/chat/scripts/live-delivery.integration.test.ts` or split only if the existing file becomes difficult to read.
- Add `apps/chat/scripts/restart-recovery.integration.test.ts` for host-side restart orchestration.
- Add `compose.integration.yaml` only for the test-only direct host mapping to `chat-1`.
- Let the main agent modify the root integration command and any shared Compose configuration after the integration agent reports its required interface.

Steps:

1. Reuse the existing isolated Compose project, three chat instances, Nginx, PostgreSQL, Redis, and cleanup trap.
2. Pin the recipient's initial socket to `chat-1`.
3. Disconnect the recipient and send several messages through Nginx.
4. Call `/api/sync` directly on `chat-2` from the integration-test container.
5. Assert all events arrive once, in sequence, with enriched conversation metadata.
6. Keep the independent Nginx HTTP and WebSocket smoke assertions.
7. Use the integration Compose override to publish a random loopback-only host port for the known `chat-1` container; discover it with `docker compose port` rather than hard-coding a port.
8. Run the host-side Node test against that known instance, invoke `docker compose -p tether-integration restart chat-1` with `execFile`, send through the still-healthy Nginx proxy while the direct socket is disconnected, then verify reconnect plus `/sync` catches up.
9. Keep the Docker socket out of application and test containers; restart authority stays in the explicit host-side test process.
10. Keep sustained traffic-time kill testing in Phase 6.
11. Remove all disposable users, sessions, conversations, and sync rows in `finally`; tear down the isolated volume even on failure.

Verification:

- Offline catch-up fails if `/sync` is absent or instance-local.
- The restart test fails if reconnect does not invoke synchronization.
- No integration containers, networks, or volumes remain after the command exits.

## Task 8 — Final verification and handoff

Run and report:

1. Affected focused tests during implementation.
2. Full `pnpm test`.
3. Chat TypeScript check.
4. Web TypeScript check.
5. Next.js production build.
6. `pnpm test:integration`, including offline and restart scenarios.
7. `docker compose config --quiet`.
8. `git diff --check`.
9. Review generated migration SQL and metadata together.
10. Confirm `.agents/`, `skills-lock.json`, secrets, `.next`, and dependencies remain ignored.

## Exit criteria mapping

- Offline messages after reconnect: Tasks 3, 5, 6, and 7.
- Server restart causes reconnect and catch-up: Tasks 6 and 7.
- Client crash and repeated sync are safe: Tasks 5 and 6.
- New device snapshot starts at a safe current sequence: Tasks 3, 5, and 6.
- Expired cursor atomically rebuilds local state: Tasks 3, 5, and 6.

## Suggested commit boundary

Keep Phase 4 as one cohesive commit unless review reveals a useful smaller boundary. The final commit message requires explicit user approval.
