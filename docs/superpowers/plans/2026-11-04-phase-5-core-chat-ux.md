# Phase 5 core chat UX implementation plan

## Goal

Build the first complete Tether chat experience on top of Phase 4: exact-email conversation creation, direct and group chat screens, optimistic idempotent sending, durable account-wide unread state, bounded typing indicators, and multi-device presence that remains correct across three chat-server instances.

## Working constraints

- Preserve the approved design in `docs/superpowers/specs/2026-11-04-phase-5-core-chat-ux-design.md`.
- Empty conversations remain absent from snapshots and conversation lists until their first message commits.
- Read state is private to the current account and synchronizes only that account's devices; do not add sender-visible receipts.
- Use normalized exact-email equality only; do not add partial search or a user directory.
- Keep PostgreSQL authoritative for read pointers and Redis authoritative only for ephemeral typing and presence.
- Keep the application schema in `apps/chat/src/db/schema.ts`; Better Auth continues to own its tables.
- Add no production dependency. Use existing packages and browser/platform APIs.
- Preserve server module factories, singleton exports, inferred service types, strict TypeScript, ESM `.js` server imports, and stable public errors.
- Do not edit applied migrations. Generate and review new SQL and metadata together.
- Do not commit without separately approving the commit message.

## Execution order

Implement in the order below. The database and event contract must be green before client schemas change; client storage must be green before React components consume it. Shared files such as `schema.ts`, `index.ts`, `chat-types.ts`, `chat-store.ts`, `live-socket.ts`, package manifests, and the lockfile must have one editor at a time.

## Task 1 — Add read-state and generalized event/outbox schema

Files:

- Modify `apps/chat/src/db/schema.ts`.
- Generate a new migration and metadata under `apps/chat/drizzle/`.
- Add or extend migration integration tests under the owning chat/read-state modules.

Steps:

1. Add `conversation_read_state` with composite primary key `(conversation_id, user_id)`, non-negative `last_read_sequence`, and `updated_at`.
2. Make `account_events.message_id` nullable and add a check that `message.created` requires it while `conversation.read` forbids it.
3. Preserve message-event uniqueness for non-null `(user_id, message_id)` values.
4. Add nullable `outbox_events.account_event_id`, make `message_id` nullable, and add type-aware checks so exactly one reference is present for each supported event type.
5. Add uniqueness for `account_event_id` while preserving one message outbox row per message.
6. Add the required foreign keys and indexes without changing Better Auth-owned table definitions.
7. Enrich existing `message.created` payload conversation objects with sorted member profiles read from the Better Auth user table. Leave already enriched rows unchanged.
8. Review generated schema SQL, custom data SQL, journal, and metadata snapshot as one unit.

Tests:

- Existing message events and outbox rows migrate without changing their IDs, sequences, or publication state.
- Old conversation payloads gain complete sorted member profiles.
- Invalid type/reference combinations fail database constraints.
- Multiple read events with null `message_id` remain valid while duplicate message events remain forbidden.

## Task 2 — Add authenticated exact-email lookup

Files:

- Add `apps/chat/src/modules/directory/directory.service.ts`.
- Add `apps/chat/src/modules/directory/directory.controller.ts`.
- Add `apps/chat/src/modules/directory/directory.routes.ts`.
- Add colocated service/controller tests.
- Modify `apps/chat/src/index.ts`.

Steps:

1. Register an authenticated `POST /api/users/lookup` endpoint with body `{ email }`.
2. Validate and normalize the input by trimming and lowercasing it.
3. Query only exact normalized email equality and select only `id`, `name`, and `email` from Better Auth's user table.
4. Return a stable not-found response without alternatives or partial results.
5. Never accept a user ID from this endpoint and never log lookup values.
6. Preserve Better Auth ownership by using a focused read query rather than defining its table in the application schema.

Tests:

- Exact normalized email returns the expected public profile.
- Partial, prefix, suffix, malformed, and absent emails do not match.
- Missing authentication returns `401`.
- Raw validation and database errors are not exposed.

## Task 3 — Add the durable mark-read transaction

Files:

- Add `apps/chat/src/modules/read-state/read-state.service.ts`.
- Add `apps/chat/src/modules/read-state/read-state.controller.ts`.
- Add `apps/chat/src/modules/read-state/read-state.routes.ts`.
- Add colocated controller and PostgreSQL integration tests.
- Modify `apps/chat/src/index.ts`.

Steps:

1. Register `PUT /api/conversations/:id/read` with body `{ sequence }`.
2. Authenticate and validate the conversation UUID and positive safe integer before calling the service.
3. In one transaction, verify current membership and verify the target message sequence exists in that conversation.
4. Lock or create the user's read-state row and compare against the existing pointer.
5. Return the canonical existing pointer without allocating an event when the target is equal or lower.
6. For a forward advancement, update the pointer, allocate exactly one next user account sequence, insert one `conversation.read` account event, and insert one outbox row referencing that event.
7. Return stable `404` and `403` results consistent with existing chat operations.
8. Keep the service factory, singleton, and inferred service type pattern.

Tests:

- A member advances from zero and receives exactly one ordered account event and outbox row.
- Repeating or lowering the sequence creates no additional durable rows.
- Concurrent devices serialize to the maximum sequence without backward movement or duplicate allocation.
- A sequence from another conversation and a future sequence are rejected.
- A nonmember cannot advance read state.
- Forced failure after each mutation point leaves no partial pointer, sync sequence, event, or outbox row.

## Task 4 — Generalize publication, realtime dispatch, and sync

Files:

- Modify `apps/chat/src/modules/outbox/outbox.publisher.ts` and tests.
- Modify `apps/chat/src/modules/realtime/realtime.ts` and tests.
- Modify `apps/chat/src/modules/chat/chat.service.ts` and tests.
- Modify `apps/chat/src/modules/sync/sync.service.ts` and tests.

Steps:

1. Define a Zod-discriminated outbox envelope union for `message.created` and `conversation.read`.
2. Keep the existing message publisher path: load the canonical message plus all affected account events, publish once, then mark the outbox row published.
3. Add the read path: load the referenced account event, publish one user-scoped envelope, then mark the row published.
4. Dispatch message envelopes to the conversation room and affected user rooms exactly as before.
5. Dispatch read envelopes only to `user:<userId>` as `account.event`; never expose them to conversation members.
6. Extend message event conversation metadata with sorted `{ id, name, email }` members inside the existing send transaction.
7. Extend sync snapshots with member profiles and `lastReadSequence`, treating missing read state as zero.
8. Preserve the single repeatable-read snapshot and contiguous mixed-event pagination.
9. Keep empty conversations excluded.

Tests:

- Pending message and read outbox rows both publish and claim exactly once.
- Invalid or incomplete discriminated envelopes are rejected.
- Read events reach the user's local sockets but not the conversation room.
- Message delivery behavior remains unchanged.
- Snapshots return profiles and read state consistently.
- Mixed message/read event pages remain ordered and contiguous.

## Task 5 — Add Redis presence leases

Files:

- Add `apps/chat/src/modules/presence/presence.service.ts` and tests.
- Add focused socket integration in the presence module or realtime module.
- Modify `apps/chat/src/modules/realtime/socket.controller.ts` only for delegation.
- Modify `apps/chat/src/index.ts` for lifecycle composition.

Steps:

1. Create one Redis-backed presence service per chat-server process using the validated `env.redisUrl`.
2. On authenticated socket connection, add `socket.id` to the user's sorted lease set with an expiry 30 seconds ahead.
3. Refresh local socket leases every 10 seconds without refreshing leases owned by other processes.
4. On normal disconnect, remove only that socket member.
5. Bound key lifetime and remove or ignore expired sorted-set members on reads.
6. Consider a user online when any score is later than the query time.
7. Add an acknowledged `presence.get` socket command accepting only a conversation ID.
8. Verify current membership, load that conversation's member IDs, and return only those members' current booleans.
9. Close timers and the dedicated Redis connection during graceful server teardown.

Tests:

- One connection becomes online and normal disconnect becomes offline.
- One disconnected device does not make another active device offline.
- Leases from different chat-server instances compose in the same Redis state.
- A stopped/crashed instance's leases become offline within 30 seconds.
- Another device continuing to refresh preserves online state.
- Nonmembers cannot query a conversation's presence.

## Task 6 — Add authorized typing events

Files:

- Add a focused typing module under `apps/chat/src/modules/realtime/` if needed to keep `socket.controller.ts` small.
- Extend socket-controller and multi-instance realtime tests.

Steps:

1. Validate `typing.start` and `typing.stop` payloads with Zod using only `conversationId`.
2. Derive the sender identity from the authenticated socket.
3. Require the socket to be in the server-authorized conversation room before accepting either event.
4. Rate-limit starts to one accepted pulse per socket and conversation per second.
5. Broadcast accepted changes to the conversation room excluding the sender through the existing Socket.IO Redis adapter.
6. Clear local limiter state when a socket disconnects.
7. Store no typing state in PostgreSQL, Redis, the outbox, or account events.

Tests:

- Authorized typing crosses chat-server instances.
- Invalid payloads, nonmembers, unjoined sockets, and over-limit pulses are not broadcast.
- Stop events are delivered promptly but correctness does not depend on them.
- Disconnect clears server-local limiter state.

## Task 7 — Upgrade client schemas and IndexedDB projection

Files:

- Modify `apps/web/lib/chat-types.ts` and tests.
- Modify `apps/web/lib/chat-store.ts` and tests.
- Modify `apps/web/lib/chat-sync.ts` and tests.

Steps:

1. Add member-profile, read-state, directory-result, mark-read, typing, and presence response schemas at their external trust boundaries.
2. Convert account events to a discriminated union and preserve relationship validation for message events.
3. Upgrade the per-user IndexedDB schema with a `readState` store keyed by conversation ID.
4. Include `readState` in atomic event-page, live-event, and snapshot transactions.
5. Apply read pointers monotonically and reject malformed or regressing event pages before advancing the token.
6. Add projection queries for visible conversations ordered by latest message, latest-message preview, unread count, and chronological conversation messages.
7. Keep room and history writes from changing read state or sync tokens.
8. Notify subscribers after committed local writes using platform `EventTarget`; do not add a state library.

Tests with `fake-indexeddb`:

- Message and read events apply atomically with their token.
- Forced write failure rolls back projection and token.
- Snapshot replacement clears and restores read state atomically.
- Downloading messages alone does not change unread counts.
- Read events update unread counts on another simulated device.
- Conversation ordering, previews, and direct/group presentation use confirmed local data.
- Empty conversations are absent.

## Task 8 — Build optimistic send, read observation, typing, and presence coordinators

Files:

- Add `apps/web/lib/chat-client.ts` and focused tests.
- Add small focused helpers only where their behavior can be tested independently.
- Modify `apps/web/lib/live-events.ts` and `apps/web/lib/live-socket.ts`.

Steps:

1. Compose the IndexedDB store, sync coordinator, socket, HTTP commands, and `EventTarget` subscriptions for one authenticated user.
2. Join only the active conversation room and leave the previous one on navigation.
3. Generate one `crypto.randomUUID()` per submitted message and render an in-memory optimistic entry immediately.
4. On success, store the canonical response and remove the matching optimistic item.
5. On failure, retain a visible failed entry; retry the same content with the same `clientMessageId`.
6. Add a read coordinator that accepts observed confirmed sequences, coalesces to the highest desired value, permits one request at a time, and retries after connection/visibility triggers.
7. Emit typing start immediately and every two seconds while non-whitespace text remains; stop on send, clear, blur, navigation, and teardown.
8. Expire received typing participants five seconds after their latest start pulse.
9. Query active-conversation presence immediately and every 10 seconds while visible; clear stale online claims on failure or expiry.
10. Preserve Phase 4 startup, reconnect, gap, foreground, abort, and cleanup behavior.

Tests:

- Optimistic success, failure, and retry reuse exactly one client ID.
- Canonical room/account replay does not duplicate an optimistic message.
- Read requests coalesce, move only forward, and retry the highest sequence.
- Hidden documents and inactive conversations do not advance read state.
- Typing pulses start, refresh, stop, and expire after a lost stop.
- Presence polling starts/stops with the active visible chat and clears stale results.
- Teardown removes listeners, timers, observers, socket state, and database handles.

## Task 9 — Build the responsive core chat interface

Files:

- Modify `apps/web/app/page.tsx`.
- Modify `apps/web/app/layout.tsx` only to load global styling when needed.
- Add `apps/web/app/globals.css`.
- Add focused chat components under `apps/web/app/` rather than growing one page file.

Steps:

1. Preserve the existing sign-in/sign-up flow and replace only the authenticated placeholder.
2. Implement the approved compact warm-neutral two-pane desktop shell.
3. Render a locally filtered conversation rail with latest preview, unread badge, and signed-in account.
4. Implement one compact new-chat form for direct and group modes using exact-email lookup.
5. Keep a newly created empty conversation only as an active draft; add it to the rail only after a confirmed first message materializes it.
6. Render chronological confirmed messages plus in-memory optimistic states and retry controls.
7. Add history loading that preserves the user's scroll anchor.
8. Use `IntersectionObserver` to report the highest visible confirmed message only while the active pane and document are visible.
9. Render active-chat presence and locally expiring typing text with accessible live regions.
10. Support Enter to send, Shift+Enter for a newline, labels, keyboard navigation, focus-visible styles, and stable status/error output.
11. On mobile, show either the conversation list or selected chat with a back action.
12. Avoid a generic design system, animation framework, or additional screen set.

Verification:

- Sign-in and sign-out lifecycle still opens and closes one chat runtime.
- Direct and group creation validate unresolved or duplicate emails accessibly.
- First-message success adds the conversation; abandoned drafts remain absent.
- Optimistic sending, failure, and retry are visibly distinct.
- Opening/downloading alone does not clear unread state; actual visible messages do.
- Desktop and narrow mobile layouts remain usable with keyboard and touch.

## Task 10 — Extend multi-instance and crash coverage

Files:

- Extend existing chat integration scripts under `apps/chat/scripts/`.
- Modify `scripts/test-integration.sh` or `compose.integration.yaml` only when the permanent scenario requires it.

Steps:

1. Reuse the isolated three-instance Nginx/PostgreSQL/Redis stack.
2. Prove reading on one device emits one durable event and updates another device connected to a different instance.
3. Prove authorized typing crosses instances and disappears after a lost stop/disconnect deadline.
4. Connect the same user through two instances, stop one instance, and prove the user remains online through the other device.
5. Stop the final serving instance without a clean disconnect and prove presence becomes offline within 30 seconds.
6. Keep all Docker restart authority in the explicit host-side test harness.
7. Clean test users, sessions, conversations, read state, events, and outbox rows in `finally`; tear down the isolated volume on every exit.

## Task 11 — Final review and verification

Run and report:

1. Focused tests during every task.
2. Full chat tests against fresh isolated PostgreSQL and Redis.
3. Full web tests with `fake-indexeddb`.
4. Chat and web TypeScript checks.
5. Next.js production build.
6. Browser smoke testing for authenticated desktop and mobile flows.
7. The permanent Nginx multi-instance integration suite, including read, typing, and presence crash cases.
8. `docker compose config --quiet`.
9. `git diff --check`.
10. Migration SQL/metadata review and a final Phase 5 spec review.
11. Confirm `.agents/`, `skills-lock.json`, `.superpowers/`, secrets, `.next`, and dependency directories remain ignored.

The root `pnpm test` currently assumes a local PostgreSQL role named `tether` on port 5433. If that environment remains broken, report the exact failure and use the disposable isolated stack as the authoritative chat-suite result rather than changing or deleting the user's existing database volume.

## Exit criteria mapping

- Correct unread counts after sync without download-as-read: Tasks 3, 4, 7, 8, and 9.
- Reading on one device updates another: Tasks 3, 4, 7, 8, and 10.
- Typing expires after idle/disconnect or lost stop: Tasks 6, 8, 9, and 10.
- Crashed-server presence expires within 30 seconds unless another device is active: Tasks 5, 8, 9, and 10.

## Suggested commit boundary

Keep Phase 5 as one cohesive commit after implementation and review. The final commit message requires explicit user approval.
