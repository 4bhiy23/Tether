import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { io, type Socket } from "socket.io-client";
import { pool } from "../src/db.js";

const proxyUrl = process.env.CHAT_PROXY_URL!;
const instanceUrls = [process.env.CHAT_INSTANCE_ONE_URL!, process.env.CHAT_INSTANCE_TWO_URL!];
const origin = process.env.WEB_ORIGIN!;

type Message = {
  id: string;
  conversationId: string;
  sequence: number;
};

type AccountEvent = {
  id: string;
  sequence: number;
  payload: {
    message: Message;
    conversation: {
      id: string;
      memberIds: string[];
    };
  };
};

type EventPage = {
  mode: "events";
  events: AccountEvent[];
  nextToken: number;
  hasMore: boolean;
  resetRequired: false;
};

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

async function sendMessage(cookie: string, conversationId: string, content: string) {
  const response = await fetch(`${proxyUrl}/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ clientMessageId: randomUUID(), content }),
  });
  if (response.status !== 201) assert.fail(`${response.status}: ${await response.text()}`);
  return (await response.json()) as Message;
}

async function sync(cookie: string, after: number) {
  const response = await fetch(`${instanceUrls[1]}/api/sync?after=${after}&limit=2`, {
    headers: { cookie, origin },
  });
  if (!response.ok) assert.fail(`${response.status}: ${await response.text()}`);
  return (await response.json()) as EventPage;
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

test("delivers live events and catches an offline recipient up from another instance", async () => {
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
      connect(instanceUrls[1], alice.cookie),
      connect(instanceUrls[0], bob.cookie),
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
    const message = await sendMessage(alice.cookie, conversation.id, "cross-instance delivery");

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

    const lastProcessedSequence = (bobEvents[0] as AccountEvent).sequence;
    bobSocket.disconnect();
    const offlineMessages = [
      await sendMessage(alice.cookie, conversation.id, "offline one"),
      await sendMessage(alice.cookie, conversation.id, "offline two"),
      await sendMessage(alice.cookie, conversation.id, "offline three"),
    ];

    const firstPage = await sync(bob.cookie, lastProcessedSequence);
    const secondPage = await sync(bob.cookie, firstPage.nextToken);
    const events = [...firstPage.events, ...secondPage.events];

    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.events.length, 2);
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.events.length, 1);
    assert.deepEqual(
      events.map((event) => event.sequence),
      [lastProcessedSequence + 1, lastProcessedSequence + 2, lastProcessedSequence + 3],
    );
    assert.equal(new Set(events.map((event) => event.id)).size, events.length);
    assert.deepEqual(
      events.map((event) => event.payload.message.id),
      offlineMessages.map((offlineMessage) => offlineMessage.id),
    );
    for (const event of events) {
      assert.equal(event.payload.conversation.id, conversation.id);
      assert.deepEqual(event.payload.conversation.memberIds, [alice.id, bob.id].sort());
    }
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
