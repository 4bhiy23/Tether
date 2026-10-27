# Modular backend refactor implementation plan

## Objective

Move chat and device-session code into feature-first modules without changing behavior, schemas, migrations, dependencies, or public APIs.

## Scope

- Move each feature's controller, routes, service, and test into `src/modules/<feature>/`.
- Update only the imports affected by those moves.
- Update the chat test command to discover root and module tests.
- Preserve all existing uncommitted Phase 2 work.

## Step 1: Record the baseline

Before moving files:

1. Record `git status --short` so existing user changes remain distinguishable.
2. Record checksums for `apps/chat/src/db/schema.ts`, `apps/chat/drizzle.config.ts`, and every file under `apps/chat/drizzle/`.
3. Search `apps/chat/src` for every import of the controllers, routes, services, and tests being moved.
4. Run the existing chat TypeScript check and `pnpm test`. Record any baseline failures instead of changing unrelated code.

## Step 2: Move the device-session module

Create `apps/chat/src/modules/device-sessions/` and move:

- `controllers/device-session.controller.ts`
- `routes/device-session.routes.ts`
- `services/device-session.service.ts`
- `device-session.service.test.ts`

Update only their relative imports:

- Controller to its colocated service.
- Routes to its colocated controller.
- Service and test to shared `auth.ts`.
- Test to its colocated service.
- `index.ts` to the module's routes and service.

Do not change exported names, function signatures, status values, authentication behavior, or socket-disconnection behavior.

## Step 3: Move the chat module

Create `apps/chat/src/modules/chat/` and move:

- `controllers/chat.controller.ts`
- `routes/chat.routes.ts`
- `services/chat.service.ts`
- `chat.service.test.ts`

Update only their relative imports:

- Controller to its colocated chat service and the device-session service.
- Routes to its colocated controller.
- Service and test to shared `db.ts` and `db/schema.ts`.
- Test to its colocated service.
- `index.ts` to the module's routes.

Do not change request validation, authorization, transactions, idempotency, event allocation, or outbox behavior.

## Step 4: Preserve test discovery

Change the chat package test command so the test runner receives both patterns:

```text
src/*.test.ts src/modules/*/*.test.ts
```

Keep the existing environment setup, migrations, and `--test-concurrency=1` behavior unchanged.

## Step 5: Verify the refactor

1. Search for stale imports referencing `src/controllers`, `src/routes`, or `src/services`.
2. Confirm the old layer directories contain no source files.
3. Recompute the schema and migration checksums and confirm they exactly match the baseline.
4. Run the chat TypeScript compiler with no output.
5. Run `pnpm test` and confirm the env, chat, and device-session tests execute.
6. Run `git diff --check`.
7. Review the diff to confirm it contains file moves, import changes, and the test-script update only.

## Expected result

```text
apps/chat/src/modules/chat/
apps/chat/src/modules/device-sessions/
```

contain all feature-specific backend code. Shared `auth.ts`, `db.ts`, `env.ts`, `index.ts`, and `db/schema.ts` remain in place. Runtime behavior and database artifacts remain unchanged.

## Stop conditions

Stop and report before expanding scope if:

- A move requires changing a public API or database schema.
- Baseline tests fail for a reason unrelated to file layout.
- Existing uncommitted work conflicts with a target path.
- Test discovery cannot include all three existing tests without broader script changes.
