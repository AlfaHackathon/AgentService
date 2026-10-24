import { randomUUID } from 'node:crypto';
import { readSql } from '../shared/read-sql.ts';
import type { Sql } from '../shared/sql.ts';
import { type ChatListOptions, type ChatUpdate, decodeCursor, encodeCursor } from './schema.ts';

const queries = {
  create: readSql('chats/create.sql'),
  get: readSql('chats/get.sql'),
  list: readSql('chats/list.sql'),
  update: readSql('chats/update.sql'),
  touch: readSql('chats/touch.sql'),
  owner: readSql('chats/owner.sql'),
};

type ChatRow = {
  id: string;
  owner_user_id: string;
  agent_key: 'client-assistant';
  title: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

export type Chat = {
  id: string;
  agentKey: 'client-assistant';
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

function mapChat(row: ChatRow): Chat {
  return {
    id: row.id,
    agentKey: row.agent_key,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

export class ChatRepository {
  constructor(private readonly sql: Sql) {}

  // Runtime route identity, never a message uid or a model-supplied owner.
  async owner(id: string): Promise<string | null> {
    const { rows } = await this.sql.query<{ owner_user_id: string }>(queries.owner, [id]);
    return rows[0]?.owner_user_id ?? null;
  }

  async create(ownerId: string, title = 'Новый чат'): Promise<Chat> {
    const { rows } = await this.sql.query<ChatRow>(queries.create, [randomUUID(), ownerId, title]);
    const row = rows[0];
    if (!row) throw new Error('Chat insert returned no row');
    return mapChat(row);
  }

  async get(id: string, ownerId: string): Promise<Chat | null> {
    const { rows } = await this.sql.query<ChatRow>(queries.get, [id, ownerId]);
    return rows[0] ? mapChat(rows[0]) : null;
  }

  async list(ownerId: string, options: ChatListOptions) {
    const cursor = options.cursor ? decodeCursor(options.cursor, options.archive) : undefined;
    const { rows } = await this.sql.query<ChatRow>(queries.list, [
      ownerId,
      options.archive,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      options.limit + 1,
    ]);
    const items = rows.slice(0, options.limit).map(mapChat);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > options.limit && last
          ? encodeCursor({
              version: 1,
              archive: options.archive,
              updatedAt: last.updatedAt,
              id: last.id,
            })
          : null,
    };
  }

  async update(id: string, ownerId: string, patch: ChatUpdate): Promise<Chat | null> {
    const { rows } = await this.sql.query<ChatRow>(queries.update, [
      id,
      ownerId,
      patch.title ?? null,
      patch.archived ?? null,
    ]);
    return rows[0] ? mapChat(rows[0]) : null;
  }

  async touch(id: string, ownerId: string): Promise<void> {
    await this.sql.query(queries.touch, [id, ownerId]);
  }
}
