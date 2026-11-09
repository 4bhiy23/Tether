import { sql } from "drizzle-orm";
import { db } from "../../db.js";

type Database = typeof db;

export function createDirectoryService(database: Database = db) {
  return {
    async findByEmail(email: string) {
      const result = await database.execute<{ id: string; name: string; email: string }>(sql`
        select id, name, email
        from "user"
        where email = ${email}
        limit 1
      `);
      return result.rows[0] ?? null;
    },
  };
}

export const directoryService = createDirectoryService();
export type DirectoryService = typeof directoryService;
