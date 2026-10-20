import { postgres } from '@flue/postgres';
import { Pool } from 'pg';
import { z } from 'zod';
import { readSql } from './read-sql.ts';
import type { Sql } from './sql.ts';

const transactions = {
  begin: readSql('transactions/begin.sql'),
  commit: readSql('transactions/commit.sql'),
  rollback: readSql('transactions/rollback.sql'),
};

export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(process.env.DATABASE_POOL_MAX ?? 10),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    query_timeout: 10000,
    application_name: 'agent-service',
  });
  pool.on('error', () => console.error(JSON.stringify({ event: 'postgres.pool_error' })));
  return pool;
}

export async function withTransaction<T>(pool: Pool, work: (sql: Sql) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(transactions.begin);
    const result = await work(client);
    await client.query(transactions.commit);
    return result;
  } catch (error) {
    await client.query(transactions.rollback);
    throw error;
  } finally {
    client.release();
  }
}

export function createFlueDatabase(pool: Pool) {
  return postgres({
    query: async (text, params) => (await pool.query(text, params)).rows,
    transaction: (work) =>
      withTransaction(pool, (sql) =>
        work({
          query: async (text, params) => (await sql.query(text, params)).rows,
        }),
      ),
    close: () => pool.end(),
  });
}
