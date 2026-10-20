import { z } from 'zod';
import { applyMigrations } from './shared/migrations.ts';
import { createFlueDatabase, createPool, withTransaction } from './shared/postgres.ts';

export const pool = createPool(z.url().parse(process.env.DATABASE_URL));

try {
  await withTransaction(pool, applyMigrations);
} catch (error) {
  await pool.end();
  throw error;
}

export default createFlueDatabase(pool);
