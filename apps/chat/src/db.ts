import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "./env.js";
import * as schema from "./db/schema.js";

export const pool = new Pool({ connectionString: env.databaseUrl });
export const db = drizzle({ client: pool, schema });
