import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSql } from './read-sql.ts';
import type { Sql } from './sql.ts';

const queries = {
  acquireLock: readSql('migrations/acquire-lock.sql'),
  initialize: readSql('migrations/initialize.sql'),
  list: readSql('migrations/list.sql'),
  record: readSql('migrations/record.sql'),
};

// The caller supplies one transaction, including migration bookkeeping.
export async function applyMigrations(sql: Sql, directory = join(process.cwd(), 'migrations')) {
  await sql.query(queries.acquireLock);
  await sql.query(queries.initialize);
  const { rows } = await sql.query<{ name: string; checksum: string }>(queries.list);
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));
  const names = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  for (const name of names) {
    const text = (await readFile(join(directory, name), 'utf8')).replace(/\r\n/g, '\n');
    const checksum = createHash('sha256').update(text).digest('hex');
    if (applied.has(name)) {
      if (applied.get(name) !== checksum) throw new Error(`Applied migration changed: ${name}`);
      continue;
    }
    await sql.query(text);
    await sql.query(queries.record, [name, checksum]);
  }
}
