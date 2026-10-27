import { z } from "zod";

const envSchema = z.object({
  CHAT_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  DATABASE_URL: z
    .url()
    .refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol)),
  REDIS_URL: z
    .url()
    .refine((value) => ["redis:", "rediss:"].includes(new URL(value).protocol)),
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
});

export function readEnv(source: NodeJS.ProcessEnv) {
  const values = envSchema.parse(source);

  return {
    chatPort: values.CHAT_PORT,
    databaseUrl: values.DATABASE_URL,
    redisUrl: values.REDIS_URL,
    webOrigin: values.WEB_ORIGIN,
  };
}

export const env = readEnv(process.env);
