import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  deviceSessionService,
  type DeviceSessionService,
} from "../device-sessions/device-session.service.js";
import { directoryService, type DirectoryService } from "./directory.service.js";

const lookupBody = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) });

export function createDirectoryController(
  directory: DirectoryService = directoryService,
  sessions: DeviceSessionService = deviceSessionService,
) {
  return {
    lookup: async (c: Context) => {
      if (!(await sessions.getCurrent(c.req.raw.headers))) throw new HTTPException(401);
      const input = lookupBody.safeParse(await c.req.json().catch(() => null));
      if (!input.success) throw new HTTPException(400);
      const user = await directory.findByEmail(input.data.email);
      if (!user) throw new HTTPException(404);
      return c.json(user);
    },
  };
}
