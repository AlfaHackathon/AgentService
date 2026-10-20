import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

export async function createTestDatabase() {
  const db = new PGlite();
  await db.exec(await readFile(new URL('../../migrations/001_chats.sql', import.meta.url), 'utf8'));
  return db;
}
