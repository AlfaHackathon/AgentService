import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatRepository } from '../src/chats/repository.ts';
import { InvalidCursorError } from '../src/chats/schema.ts';
import { createTestDatabase } from './helpers/database.ts';

const setChatTimestampSql = readFileSync(
  new URL('./sql/set-chat-timestamp.sql', import.meta.url),
  'utf8',
);

describe('PostgreSQL chat catalogue', () => {
  let db: PGlite;
  let chats: ChatRepository;
  beforeEach(async () => {
    db = await createTestDatabase();
    chats = new ChatRepository(db);
  });
  afterEach(async () => {
    await db.close();
  });

  it('isolates owners for reads, writes and listing', async () => {
    const chat = await chats.create('alice', 'Первый');
    await chats.create('bob', 'Другой');
    expect(await chats.get(chat.id, 'bob')).toBeNull();
    expect(await chats.update(chat.id, 'bob', { title: 'stolen' })).toBeNull();
    const page = await chats.list('alice', { archive: 'active', limit: 20 });
    expect(page.items.map((item) => item.title)).toEqual(['Первый']);
  });

  it('paginates equal timestamps without missing or repeating chats', async () => {
    for (let n = 0; n < 5; n++) await chats.create('alice', `Чат ${n}`);
    await db.query(setChatTimestampSql, ['2026-10-20T00:00:00.123Z']);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await chats.list('alice', {
        archive: 'active',
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('renames, archives and restores without losing metadata', async () => {
    const chat = await chats.create('alice');
    await chats.update(chat.id, 'alice', { title: 'План', archived: true });
    expect((await chats.list('alice', { archive: 'active', limit: 20 })).items).toHaveLength(0);
    expect((await chats.list('alice', { archive: 'archived', limit: 20 })).items[0]?.title).toBe(
      'План',
    );
    expect(await chats.update(chat.id, 'alice', { archived: false })).toMatchObject({
      title: 'План',
      archivedAt: null,
    });
  });

  it('rejects malformed cursors and cursors from a different archive filter', async () => {
    await expect(
      chats.list('alice', { archive: 'active', limit: 1, cursor: 'garbage' }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    await chats.create('alice');
    await chats.create('alice');
    const page = await chats.list('alice', { archive: 'active', limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    await expect(
      chats.list('alice', { archive: 'archived', limit: 1, cursor: page.nextCursor ?? '' }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });
});
