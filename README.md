# Tether

Tether is a multi-instance chat application.

## Apps

- `apps/web` — Next.js chat client.
- `apps/chat` — Hono HTTP API and Socket.IO server.

## Local services

PostgreSQL stores durable chat data. Redis routes live cross-instance events and presence leases.

```sh
cp .env.example .env
docker compose up -d
pnpm install
pnpm dev
```

The chat server listens on `http://localhost:3001`; the web app listens on Next.js's default port.

## Design documents

See [`docs/`](docs/) for the system design and decision record.
