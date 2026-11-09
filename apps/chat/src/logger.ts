import pino, { type DestinationStream } from "pino";
import { env } from "./env.js";

export function createLogger(
  instanceId = env.instanceId,
  level = env.logLevel,
  destination?: DestinationStream,
) {
  return pino(
    {
      level,
      base: { service: "tether-chat", instanceId },
    },
    destination,
  );
}

export const logger = createLogger();
export type AppLogger = typeof logger;
