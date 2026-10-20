import { z } from 'zod';
import { applyMigrations } from '../src/shared/migrations.ts';
import { createPool, withTransaction } from '../src/shared/postgres.ts';

const pool = createPool(z.url().parse(process.env.DATABASE_URL));
try {
  await withTransaction(pool, applyMigrations);
  console.log('AgentService migrations applied');
} finally {
  await pool.end();
}
