import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { io, type Socket } from "socket.io-client";
import { pool } from "../src/db.js";

const proxyUrl = process.env.CHAT_PROXY_URL!;
const instanceUrls = [process.env.CHAT_INSTANCE_ONE_URL!, process.env.CHAT_INSTANCE_TWO_URL!];
const origin = process.env.WEB_ORIGIN!;

async function waitForHealth(url: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await fetch(`${url}/health`).then((response) => response.ok).catch(() => false)) return;
    await delay(250);
  }
  assert.fail(`${url} did not become healthy`);
}

async function signUp(name: string) {
  const email = `${randomUUID()}@test.invalid`;
  const response = await fetch(`${proxyUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ name, email, password: "integration-password" }),
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

async function connect(url: string, cookie: string) {
  const socket = io(url, {
    autoConnect: false,
    transports: ["websocket"],
    extraHeaders: { cookie, origin },
    reconnection: false,
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Socket connection to ${url} timed out`)), 5_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", reject);
    socket.connect();
  });
  return socket;
}

async function join(socket: Socket, conversationId: string) {
  const result = await socket.timeout(5_000).emitWithAck("conversation.join", { conversationId });
  assert.deepEqual(result, { status: "joined" });
}

function collect(socket: Socket, event: string) {
  const values: unknown[] = [];
  socket.on(event, (value) => values.push(value));
  return values;
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (condition()) return;
    await delay(100);
  }
  assert.fail("Live events were not delivered in time");
}

test("delivers one message across instances through the Nginx send path", async () => {
  const sockets: Socket[] = [];
  const userIds: string[] = [];
  let conversationId: string | undefined;

  try {
    await Promise.all([proxyUrl, ...instanceUrls].map(waitForHealth));
    const alice = await signUp("Integration Alice");
    userIds.push(alice.id);
    const bob = await signUp("Integration Bob");
    userIds.push(bob.id);

    const conversationResponse = await fetch(`${proxyUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: alice.cookie, origin },
      body: JSON.stringify({ kind: "direct", memberIds: [bob.id] }),
    });
    if (conversationResponse.status !== 201) {
      assert.fail(`${conversationResponse.status}: ${await conversationResponse.text()}`);
    }
    const conversation = (await conversationResponse.json()) as { id: string };
    conversationId = conversation.id;

    const [aliceSocket, bobSocket] = await Promise.all([
      connect(instanceUrls[0], alice.cookie),
      connect(instanceUrls[1], bob.cookie),
    ]);
    sockets.push(aliceSocket, bobSocket);
    await Promise.all([join(aliceSocket, conversation.id), join(bobSocket, conversation.id)]);

    const proxySocket = await connect(proxyUrl, alice.cookie);
    sockets.push(proxySocket);
    proxySocket.disconnect();

    const aliceMessages = collect(aliceSocket, "message.created");
    const bobMessages = collect(bobSocket, "message.created");
    const aliceEvents = collect(aliceSocket, "account.event");
    const bobEvents = collect(bobSocket, "account.event");
    const clientMessageId = randomUUID();
    const messageResponse = await fetch(`${proxyUrl}/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: alice.cookie, origin },
      body: JSON.stringify({ clientMessageId, content: "cross-instance delivery" }),
    });
    if (messageResponse.status !== 201) {
      assert.fail(`${messageResponse.status}: ${await messageResponse.text()}`);
    }
    const message = (await messageResponse.json()) as { id: string };

    await waitFor(
      () =>
        aliceMessages.length === 1 &&
        bobMessages.length === 1 &&
        aliceEvents.length === 1 &&
        bobEvents.length === 1,
    );
    await delay(750);

    assert.deepEqual(aliceMessages, bobMessages);
    assert.equal((aliceMessages[0] as { id: string }).id, message.id);
    assert.equal(aliceMessages.length, 1);
    assert.equal(bobMessages.length, 1);
    assert.equal(aliceEvents.length, 1);
    assert.equal(bobEvents.length, 1);
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
  }
});
