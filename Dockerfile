FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/chat/package.json apps/chat/package.json
RUN pnpm install --frozen-lockfile --filter @tether/chat...

COPY apps/chat apps/chat

WORKDIR /app/apps/chat

EXPOSE 4000

USER node

CMD ["node", "--import", "tsx", "src/index.ts"]
