import { betterAuth } from "better-auth";
import { pool } from "./db.js";
import { env } from "./env.js";

export const auth = betterAuth({
  appName: "Tether",
  database: pool,
  emailAndPassword: { enabled: true },
  trustedOrigins: [env.webOrigin],
});
