import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { Pool } from "pg";
import { io, type Socket } from "socket.io-client";

const run = promisify(execFile);
const proxyUrl = process.env.CHAT_PROXY_URL!;
const instanceUrl = process.env.CHAT_INSTANCE_ONE_URL!;
const origin = process.env.WEB_ORIGIN!;
const composeProject = process.env.COMPOSE_PROJECT_NAME!;
const databaseUrl = process.env.DATABASE_URL!;

type Message = { id: string };
type AccountEvent = {
  id: string;
  sequence: number;
  payload: {
    message: Message;
    conversation: { id: string; memberIds: string[] };
  };
};

function requireEnvironment() {
  for (const [name, value] of Object.entries({
    CHAT_PROXY_URL: proxyUrl,
    CHAT_INSTANCE_ONE_URL: instanceUrl,
    WEB_ORIGIN: origin,
    COMPOSE_PROJECT_NAME: composeProject,
    DATABASE_URL: databaseUrl,
  })) {
    assert.ok(value, `${name} is required`);
  }
}

async function waitForHealth(url: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await fetch(`${url}/health`).then((response) => response.ok).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
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
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const result = (await response.json()) as { user: { id: string } };
  assert.ok(cookie);
  return { id: result.user.id, cookie };
}

async function connect(cookie: string) {
  const socket = io(instanceUrl, {
    autoConnect: false,
    transports: ["websocket"],
    extraHeaders: { cookie, origin },
    reconnection: true,
    reconnectionAttempts: 60,
    reconnectionDelay: 100,
    reconnectionDelayMax: 500,
  });

  await event(socket, "connect", 10_000, () => socket.connect());
  return socket;
}

function event(socket: Socket, name: "connect" | "disconnect", timeoutMs: number, start?: () => void) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(name, complete);
      reject(new Error(`Socket ${name} timed out`));
    }, timeoutMs);
    function complete() {
      clearTimeout(timeout);
      resolve();
    }
    socket.once(name, complete);
    start?.();
  });
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

async function sendMessage(cookie: string, conversationId: string, content: string) {
  const clientMessageId = randomUUID();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${proxyUrl}/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ clientMessageId, content }),
    }).catch(() => undefined);
    if (response?.status === 201 || response?.status === 200) {
      return (await response.json()) as Message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Message ${clientMessageId} was not accepted while chat-1 was stopped`);
}

async function compose(...args: string[]) {
  await run("docker", ["compose", "-p", composeProject, ...args]);
}

test("recovers committed messages after the serving instance restarts", async () => {
  requireEnvironment();
  const pool = new Pool({ connectionString: databaseUrl });
  const sockets: Socket[] = [];
  const userIds: string[] = [];
  let conversationId: string | undefined;
  let chatStopped = false;

  try {
    await Promise.all([waitForHealth(proxyUrl), waitForHealth(instanceUrl)]);
    const alice = await signUp("Restart Alice");
    userIds.push(alice.id);
    const bob = await signUp("Restart Bob");
    userIds.push(bob.id);
    const conversation = await createConversation(alice.cookie, bob.id);
    conversationId = conversation.id;

    const bobSocket = await connect(bob.cookie);
    sockets.push(bobSocket);
    const disconnected = event(bobSocket, "disconnect", 10_000);
    await compose("stop", "chat-1");
    chatStopped = true;
    await disconnected;

    const sent = [
      await sendMessage(alice.cookie, conversation.id, "committed while instance stopped one"),
      await sendMessage(alice.cookie, conversation.id, "committed while instance stopped two"),
    ];

    const reconnected = event(bobSocket, "connect", 20_000);
    await compose("start", "chat-1");
    chatStopped = false;
    await Promise.all([reconnected, waitForHealth(instanceUrl)]);

    const syncResponse = await fetch(`${proxyUrl}/api/sync?after=0&limit=100`, {
      headers: { cookie: bob.cookie, origin },
    });
    if (!syncResponse.ok) {
      assert.fail(`${syncResponse.status}: ${await syncResponse.text()}`);
    }
    const sync = (await syncResponse.json()) as {
      mode: "events";
      events: AccountEvent[];
      nextToken: number;
      hasMore: boolean;
      resetRequired: false;
    };

    assert.equal(sync.mode, "events");
    assert.equal(sync.hasMore, false);
    assert.equal(sync.resetRequired, false);
    assert.deepEqual(
      sync.events.map((accountEvent) => accountEvent.sequence),
      [1, 2],
    );
    assert.deepEqual(
      sync.events.map((accountEvent) => accountEvent.payload.message.id),
      sent.map((message) => message.id),
    );
    assert.equal(new Set(sync.events.map((accountEvent) => accountEvent.id)).size, 2);
    for (const accountEvent of sync.events) {
      assert.equal(accountEvent.payload.conversation.id, conversation.id);
      assert.deepEqual(accountEvent.payload.conversation.memberIds, [alice.id, bob.id].sort());
    }
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    if (chatStopped) await compose("start", "chat-1").catch(() => undefined);
    if (conversationId) await pool.query("delete from conversations where id = $1", [conversationId]);
    if (userIds.length) {
      await pool.query("delete from user_sync_state where user_id = any($1)", [userIds]);
      await pool.query('delete from "session" where "userId" = any($1)', [userIds]);
      await pool.query('delete from account where "userId" = any($1)', [userIds]);
      await pool.query('delete from "user" where id = any($1)', [userIds]);
    }
    await pool.end();
  }
});
