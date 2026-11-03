import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  deviceSessionService,
  type DeviceSessionService,
} from "../device-sessions/device-session.service.js";
import { syncService, type SyncService } from "./sync.service.js";

const safeInteger = z.string().min(1).pipe(z.coerce.number<string>().int().safe());
const eventQuery = z.object({
  after: safeInteger.pipe(z.number().nonnegative()),
  limit: safeInteger.pipe(z.number().min(1).max(100)).optional(),
});

export function createSyncController(
  sync: SyncService = syncService,
  sessions: DeviceSessionService = deviceSessionService,
) {
  return {
    get: async (c: Context) => {
      const session = await sessions.getCurrent(c.req.raw.headers);
      if (!session) throw new HTTPException(401);

      const after = c.req.query("after");
      const limit = c.req.query("limit");
      if (after === undefined) {
        if (limit !== undefined) throw new HTTPException(400);
        return c.json(await sync.getSnapshot(session.user.id));
      }

      const query = eventQuery.safeParse({ after, limit });
      if (!query.success) throw new HTTPException(400);
      return c.json(
        await sync.getEvents(session.user.id, query.data.after, query.data.limit ?? 100),
      );
    },
  };
}
