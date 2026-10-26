import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  deviceSessionService,
  type DeviceSessionService,
} from "../services/device-session.service.js";

export function createDeviceSessionController(
  disconnectSession: (sessionId: string) => void,
  sessions: DeviceSessionService = deviceSessionService,
) {
  return {
    current: async (c: Context) => {
      const session = await sessions.getCurrent(c.req.raw.headers);
      if (!session) throw new HTTPException(401);
      return c.json(session);
    },

    revoke: async (c: Context) => {
      const sessionId = c.req.param("id");
      if (!sessionId) throw new HTTPException(400);

      const result = await sessions.revoke(c.req.raw.headers, sessionId);
      if (result.status === "unauthenticated") throw new HTTPException(401);
      if (result.status === "not-found") throw new HTTPException(404);

      disconnectSession(result.sessionId);
      return c.body(null, 204);
    },
  };
}
