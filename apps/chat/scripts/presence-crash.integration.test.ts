import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Pool } from "pg";
import { io, type Socket } from "socket.io-client";

const run = promisify(execFile);
const proxyUrl = process.env.CHAT_PROXY_URL!;
const instanceUrls = [
  process.env.CHAT_INSTANCE_ONE_URL!,
  process.env.CHAT_INSTANCE_TWO_URL!,
  process.env.CHAT_INSTANCE_THREE_URL!,
];
const origin = process.env.WEB_ORIGIN!;
const composeProject = process.env.COMPOSE_PROJECT_NAME!;
const databaseUrl = process.env.DATABASE_URL!;

async function waitForHealth(url: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await fetch(`${url}/health`).then((response) => response.ok).catch(() => false)) return;
    await delay(250);
  }
  assert.fail(`${url} did not become healthy`);
}

async function signUp(name: string) {
  const response = await fetch(`${proxyUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      name,
      email: `${randomUUID()}@test.invalid`,
      password: "integration-password",
    }),
  });
  if (!response.ok) assert.fail(`${response.status}: ${await response.text()}`);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  const result = (await response.json()) as { user: { id: string } };
  assert.ok(cookie);
  return { id: result.user.id, cookie };
}

async function createConversation(cookie: string, memberId: string) {
  const response = await fetch(`${proxyUrl}/api/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ kind: "direct", memberIds: [memberId] }),
  });
  if (response.status !== 201) assert.fail(`${response.status}: ${await response.text()}`);
  return (await response.json()) as { id: string };
}

async function connect(url: string, cookie: string) {
  const socket = io(url, {
    autoConnect: false,
    transports: ["websocket"],
    extraHeaders: { cookie, origin },
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Socket connection to ${url} timed out`)), 10_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", reject);
    socket.connect();
  });
  return socket;
}

async function presence(socket: Socket, conversationId: string) {
  return socket.timeout(5_000).emitWithAck("presence.get", { conversationId }) as Promise<{
    status: "ok";
    members: Record<string, boolean>;
  }>;
}

async function compose(...args: string[]) {
  await run("docker", ["compose", "-p", composeProject, ...args]);
}

test("presence expires crashed sockets but preserves another active device", async () => {
  for (const [name, value] of Object.entries({
    CHAT_PROXY_URL: proxyUrl,
    CHAT_INSTANCE_ONE_URL: instanceUrls[0],
    CHAT_INSTANCE_TWO_URL: instanceUrls[1],
    CHAT_INSTANCE_THREE_URL: instanceUrls[2],
    WEB_ORIGIN: origin,
    COMPOSE_PROJECT_NAME: composeProject,
    DATABASE_URL: databaseUrl,
  })) assert.ok(value, `${name} is required`);

  const pool = new Pool({ connectionString: databaseUrl });
  const sockets: Socket[] = [];
  const userIds: string[] = [];
  const stopped = new Set<string>();
  let conversationId: string | undefined;

  try {
    await Promise.all([proxyUrl, ...instanceUrls].map(waitForHealth));
    const alice = await signUp("Presence Alice");
    const bob = await signUp("Presence Bob");
    userIds.push(alice.id, bob.id);
    const conversation = await createConversation(alice.cookie, bob.id);
    conversationId = conversation.id;

    const [bobOne, bobTwo, aliceThree] = await Promise.all([
      connect(instanceUrls[0], bob.cookie),
      connect(instanceUrls[1], bob.cookie),
      connect(instanceUrls[2], alice.cookie),
    ]);
    sockets.push(bobOne, bobTwo, aliceThree);

    assert.equal((await presence(aliceThree, conversation.id)).members[bob.id], true);

    await compose("kill", "chat-1");
    stopped.add("chat-1");
    assert.equal((await presence(aliceThree, conversation.id)).members[bob.id], true);

    await compose("kill", "chat-2");
    stopped.add("chat-2");
    const stoppedAt = Date.now();
    let online = true;
    while (online && Date.now() - stoppedAt < 35_000) {
      await delay(1_000);
      online = (await presence(aliceThree, conversation.id)).members[bob.id];
    }
    assert.equal(online, false);
    assert.ok(Date.now() - stoppedAt <= 35_000, "crashed presence exceeded its lease bound");
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    if (conversationId) await pool.query("delete from conversations where id = $1", [conversationId]);
    if (userIds.length) {
      await pool.query("delete from user_sync_state where user_id = any($1)", [userIds]);
      await pool.query('delete from "session" where "userId" = any($1)', [userIds]);
      await pool.query('delete from account where "userId" = any($1)', [userIds]);
      await pool.query('delete from "user" where id = any($1)', [userIds]);
    }
    await pool.end();
    for (const service of stopped) await compose("start", service).catch(() => undefined);
  }
});
