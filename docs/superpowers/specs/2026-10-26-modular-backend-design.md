# Modular backend refactor design

## Status

Approved for planning on 2026-10-26.

## Goal

Reorganize the chat backend by feature so each domain owns its controller, routes, service, and tests. Preserve all runtime behavior, public APIs, database behavior, and existing dependency-injection patterns.

## Current structure

Backend code is grouped by technical layer:

```text
src/
├── controllers/
├── routes/
├── services/
├── db/
├── auth.ts
├── db.ts
├── env.ts
└── index.ts
```

Adding a feature currently spreads its files across several directories. The project already has two cohesive features—chat and device sessions—so feature ownership is now clearer than layer ownership.

## Proposed structure

```text
apps/chat/src/
├── modules/
│   ├── chat/
│   │   ├── chat.controller.ts
│   │   ├── chat.routes.ts
│   │   ├── chat.service.ts
│   │   └── chat.service.test.ts
│   └── device-sessions/
│       ├── device-session.controller.ts
│       ├── device-session.routes.ts
│       ├── device-session.service.ts
│       └── device-session.service.test.ts
├── db/
│   └── schema.ts
├── auth.ts
├── db.ts
├── env.ts
├── env.test.ts
└── index.ts
```

Shared infrastructure remains at the application root. Feature code moves without introducing module classes, repositories, barrel exports, DTO classes, or a dependency-injection container.

## File moves

| Existing path | New path |
|---|---|
| `controllers/chat.controller.ts` | `modules/chat/chat.controller.ts` |
| `routes/chat.routes.ts` | `modules/chat/chat.routes.ts` |
| `services/chat.service.ts` | `modules/chat/chat.service.ts` |
| `chat.service.test.ts` | `modules/chat/chat.service.test.ts` |
| `controllers/device-session.controller.ts` | `modules/device-sessions/device-session.controller.ts` |
| `routes/device-session.routes.ts` | `modules/device-sessions/device-session.routes.ts` |
| `services/device-session.service.ts` | `modules/device-sessions/device-session.service.ts` |
| `device-session.service.test.ts` | `modules/device-sessions/device-session.service.test.ts` |

## Module boundaries

Controllers continue to authenticate requests, parse and validate untrusted input, call a service, and map service results to HTTP responses. Routes continue to register endpoint paths only. Services continue to own domain behavior and transaction boundaries.

The existing `createX(defaultDependency)` factories, singleton exports, and inferred service types remain unchanged. Modules may import shared `auth.ts`, `db.ts`, and `db/schema.ts`; feature modules must not import another feature's controller or routes.

`index.ts` remains the explicit composition root and registers each feature's routes directly.

## Schema boundary

This refactor does not move, split, or edit:

- `src/db/schema.ts`
- `drizzle.config.ts`
- Generated SQL migrations
- Drizzle migration metadata

The current schema is cohesive and already expresses the required database relationships and constraints. Schema modularization is outside this refactor.

## Behavior preservation

The following must remain unchanged:

- HTTP routes and status codes.
- Authentication and membership authorization.
- Request validation and content limits.
- Conversation creation behavior.
- Message ordering and `clientMessageId` idempotency.
- PostgreSQL transaction boundaries.
- Account-event and outbox writes.
- Device-session revocation and socket disconnection.
- Environment validation and database configuration.

No dependency or public API changes are required.

## Test discovery

Module tests will move with their feature. The chat package test script must include both root tests and tests one level below `src/modules/`, while preserving migration setup and serial execution:

```text
src/*.test.ts src/modules/*/*.test.ts
```

This keeps `env.test.ts` at the root and ensures both feature test files continue to run.

## Verification

After moving files and updating imports:

1. Confirm no imports reference the removed `controllers`, `routes`, or `services` paths.
2. Run the chat TypeScript compiler with no emit.
3. Run `pnpm test` against the existing PostgreSQL-backed suite.
4. Run `git diff --check`.
5. Confirm the diff contains only file moves, import-path changes, and the test-discovery update.

## Non-goals

- Changing schema or migrations.
- Changing application behavior.
- Adding a module framework or runtime registry.
- Adding repositories or other persistence abstractions.
- Refactoring the web client.
- Implementing later phases from the implementation plan.

## Risks

The main risk is silently excluding moved tests. The explicit test paths and observed test count must confirm that `env`, chat, and device-session tests all execute. Import-path mistakes are covered by the TypeScript check.
