import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  deviceSessionService,
  type DeviceSessionService,
} from "../device-sessions/device-session.service.js";
import { readStateService, type ReadStateService } from "./read-state.service.js";

const markReadBody = z.object({ sequence: z.number().int().safe().positive() });

export function createReadStateController(
  reads: ReadStateService = readStateService,
  sessions: DeviceSessionService = deviceSessionService,
) {
  return {
    markRead: async (c: Context) => {
      const session = await sessions.getCurrent(c.req.raw.headers);
      if (!session) throw new HTTPException(401);
      const conversationId = z.uuid().safeParse(c.req.param("id"));
      const input = markReadBody.safeParse(await c.req.json().catch(() => null));
      if (!conversationId.success || !input.success) throw new HTTPException(400);
      const result = await reads.markRead(
        session.user.id,
        conversationId.data,
        input.data.sequence,
      );
      if (result.status === "not-found") throw new HTTPException(404);
      if (result.status === "forbidden") throw new HTTPException(403);
      if (result.status === "invalid-sequence") throw new HTTPException(400);
      return c.json({
        conversationId: conversationId.data,
        lastReadSequence: result.lastReadSequence,
      });
    },
  };
}
