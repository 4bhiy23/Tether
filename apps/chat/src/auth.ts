import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { env } from "./env.js";

export const pool = new Pool({ connectionString: env.databaseUrl });

export const auth = betterAuth({
  appName: "Tether",
  database: pool,
  emailAndPassword: { enabled: true },
  trustedOrigins: [env.webOrigin],
});
