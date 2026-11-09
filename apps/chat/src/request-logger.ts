import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { logger, type AppLogger } from "./logger.js";

type RequestLogger = Pick<AppLogger, "error" | "info">;

export function createRequestLogger(
  log: RequestLogger = logger,
  now: () => number = performance.now.bind(performance),
): MiddlewareHandler {
  return async (context, next) => {
    const requestId = randomUUID();
    const startedAt = now();
    let failed = false;
    context.header("x-request-id", requestId);

    try {
      await next();
    } catch (error) {
      failed = true;
      log.error(
        {
          requestId,
          method: context.req.method,
          path: context.req.path,
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "HTTP request failed",
      );
      throw error;
    } finally {
      log.info(
        {
          requestId,
          method: context.req.method,
          path: context.req.path,
          status: failed ? 500 : context.res.status,
          durationMs: Math.round((now() - startedAt) * 100) / 100,
        },
        "HTTP request completed",
      );
    }
  };
}
