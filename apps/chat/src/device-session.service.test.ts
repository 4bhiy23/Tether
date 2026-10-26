import assert from "node:assert/strict";
import test from "node:test";
import { auth } from "./auth.js";
import { createDeviceSessionService } from "./services/device-session.service.js";

type AuthApi = Pick<typeof auth.api, "getSession" | "listSessions" | "revokeSession">;

test("revokes only a session owned by the current user", async () => {
  const revokedTokens: string[] = [];
  const fakeAuthApi = {
    getSession: async () => ({}) as never,
    listSessions: async () => [{ id: "other-device", token: "session-token" }] as never,
    revokeSession: async ({ body }: { body: { token: string } }) => {
      revokedTokens.push(body.token);
      return {} as never;
    },
  } as unknown as AuthApi;
  const service = createDeviceSessionService(fakeAuthApi);

  assert.deepEqual(await service.revoke(new Headers(), "other-device"), {
    status: "revoked",
    sessionId: "other-device",
  });
  assert.deepEqual(revokedTokens, ["session-token"]);
  assert.deepEqual(await service.revoke(new Headers(), "unknown"), { status: "not-found" });
});
