function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function url(value: string | undefined, name: string) {
  const result = required(value, name);
  try {
    new URL(result);
    return result;
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

export function readEnv(source: NodeJS.ProcessEnv) {
  const port = Number(source.CHAT_PORT ?? 4000);
  const secret = required(source.BETTER_AUTH_SECRET, "BETTER_AUTH_SECRET");
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CHAT_PORT must be a valid port");

  return {
    chatPort: port,
    databaseUrl: url(source.DATABASE_URL, "DATABASE_URL"),
    redisUrl: url(source.REDIS_URL, "REDIS_URL"),
    webOrigin: url(source.WEB_ORIGIN ?? "http://localhost:3000", "WEB_ORIGIN"),
  };
}

export const env = readEnv(process.env);
