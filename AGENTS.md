# Tether repository instructions

## Project

Tether is a multi-instance chat application. `apps/web` is the Next.js client; `apps/chat` is the Hono and Socket.IO service. PostgreSQL is the durable source of truth, Redis carries ephemeral cross-instance events, and Better Auth owns users and sessions.

Read `docs/implementation-plan.md` before phase work. Implement only the requested phase and preserve its stated exit criteria.

## Working agreement

- Inspect `git status`, relevant callers, tests, configuration, and schema before editing.
- Preserve user-owned uncommitted changes. Never reset or overwrite unrelated work.
- Make the smallest complete change. Do not add speculative options, layers, or future-phase behavior.
- Follow existing dependencies and patterns before inventing a new abstraction.
- Do not commit, push, deploy, run destructive database operations, or change infrastructure without explicit user approval.

## Libraries and small utilities

- Before hand-writing validation, parsing, identifiers, dates, retries, or similar utilities, check the platform and existing direct dependencies.
- If a mature library could solve a small nuance but would add a direct dependency or meaningful bundle/runtime cost, present the library and the small local alternative and ask the user which to use.
- Do not silently add a dependency or silently hand-roll a regex/parser when this choice exists.
- Once the user chooses a library, use it consistently at the applicable trust boundaries without forcing it into code that gains no validation or correctness benefit.

## Backend structure

- Organize feature code under `apps/chat/src/modules/<feature>/`; colocate its controller, routes, service, and tests.
- Keep shared infrastructure such as `auth.ts`, `db.ts`, `env.ts`, and `db/schema.ts` outside feature modules.
- Controllers authenticate, parse and validate untrusted input, call services, and map service results to HTTP responses.
- Routes only register endpoint paths.
- Services own domain behavior and transaction boundaries.
- `index.ts` is the explicit composition root.
- Preserve the existing `createX(defaultDependency)` factory, singleton export, and inferred service-type pattern.

## TypeScript and validation

- Keep TypeScript strict and use ESM `.js` extensions in relative server imports.
- Prefer inferred types and discriminated result objects with `as const` over duplicate interfaces.
- Use Zod at external trust boundaries: environment variables, HTTP inputs, path parameters, and public runtime configuration.
- Return stable public errors; do not expose raw Zod or database errors to clients.
- Runtime chat code reads validated configuration from `env.ts`, never directly from `process.env`.
- CLI and framework configuration may read only the environment variables that the external tool requires.

## Security and data integrity

- Authenticate on the server and authorize conversation membership at the operation boundary.
- Validate request shapes, identifiers, enum-like values, and size limits before calling services.
- Keep durable invariants in PostgreSQL constraints, not process memory.
- Keep message sequence allocation, message insertion, account-event allocation, and outbox insertion in one transaction.
- Preserve database-backed `clientMessageId` idempotency across instances.
- Never log secrets, credentials, session tokens, or message contents.

## Database

- `apps/chat/src/db/schema.ts` owns the application schema. Better Auth continues to own its tables.
- Generate migrations with the existing scripts. Do not edit an applied migration; add a new migration.
- Do not move or split schemas unless the user explicitly requests it.
- Treat generated migration SQL and metadata as coupled outputs and review both.

## Tests and verification

- Use `node:test` and `node:assert/strict` for chat tests.
- Add the smallest regression test for new validation, authorization, branching, transaction, or concurrency behavior.
- Use dependency injection for unit tests and real PostgreSQL where locks, constraints, or rollback behavior matter.
- Clean integration data in `finally` blocks.
- Run the affected TypeScript checks, `pnpm test`, and `git diff --check` before reporting completion.
- Report only checks actually run, including warnings or failures.

## Frontend

- Reuse `authClient` and existing platform behavior before adding wrappers.
- Preserve semantic HTML, labels, keyboard behavior, and accessible error/status output.
- Keep browser validation aligned with server validation; the server remains authoritative.
