import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { pool } from "../../db.js";
import { createDirectoryService } from "./directory.service.js";

test("returns only an exact stored email", async () => {
  const id = randomUUID();
  const email = `${id}@test.invalid`;
  await pool.query(
    `insert into "user" (id, name, email, "emailVerified") values ($1, 'Exact User', $2, true)`,
    [id, email],
  );
  try {
    const directory = createDirectoryService();
    assert.deepEqual(await directory.findByEmail(email), { id, name: "Exact User", email });
    assert.equal(await directory.findByEmail(id), null);
    assert.equal(await directory.findByEmail(`${id.slice(0, -1)}@test.invalid`), null);
  } finally {
    await pool.query('delete from "user" where id = $1', [id]);
    await pool.end();
  }
});
