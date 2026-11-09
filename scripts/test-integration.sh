#!/bin/sh
set -eu

export COMPOSE_PROJECT_NAME=tether-integration
project_root=$(pwd)
export COMPOSE_FILE="$project_root/compose.yaml:$project_root/compose.integration.yaml"
export BETTER_AUTH_SECRET=integration-test-secret-at-least-32-characters
export WEB_ORIGIN=http://localhost:3000
export CHAT_ONE_TEST_PORT=$(node -e 'const server = require("node:net").createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')
export CHAT_TWO_TEST_PORT=$(node -e 'const server = require("node:net").createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')
export CHAT_THREE_TEST_PORT=$(node -e 'const server = require("node:net").createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });')

cleanup() {
  docker compose --profile test down -v
}
trap cleanup EXIT INT TERM

docker compose --profile test up -d --build --wait postgres redis migrate chat-1 chat-2 chat-3 nginx
docker compose --profile test run --rm integration-test

proxy_port=$(docker compose port nginx 80)
chat_one_port=$(docker compose port chat-1 4000)
chat_two_port=$(docker compose port chat-2 4000)
chat_three_port=$(docker compose port chat-3 4000)
postgres_port=$(docker compose port postgres 5432)
export CHAT_PROXY_URL="http://127.0.0.1:${proxy_port##*:}"
export CHAT_INSTANCE_ONE_URL="http://127.0.0.1:${chat_one_port##*:}"
export CHAT_INSTANCE_TWO_URL="http://127.0.0.1:${chat_two_port##*:}"
export CHAT_INSTANCE_THREE_URL="http://127.0.0.1:${chat_three_port##*:}"
export DATABASE_URL="postgresql://tether:tether@127.0.0.1:${postgres_port##*:}/tether"

pnpm --filter @tether/chat exec node --import tsx --test scripts/restart-recovery.integration.test.ts
pnpm --filter @tether/chat exec node --import tsx --test scripts/presence-crash.integration.test.ts
