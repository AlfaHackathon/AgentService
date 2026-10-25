import { setImmediate } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';
import { closeSocketDatabase } from './helpers/close-socket-database.ts';

it('keeps the embedded database alive until its clients and queued work have drained', async () => {
  const order: string[] = [];
  const stats = { activeConnections: 1, queuedQueries: 1, maxConnections: 1 };
  const server = {
    getStats: () => stats,
    stop: vi.fn(async () => {
      order.push('listener');
    }),
    db: {
      close: vi.fn(async () => {
        order.push('database');
      }),
    },
  };
  const closing = closeSocketDatabase(server);
  try {
    await setImmediate();
    expect(order).toEqual([]);
    stats.activeConnections = 0;
    await setImmediate();
    expect(order).toEqual([]);
  } finally {
    stats.activeConnections = 0;
    stats.queuedQueries = 0;
    await closing;
  }
  expect(order).toEqual(['listener', 'database']);
});

it('drains a real embedded socket client with an open transaction before closing WASM', async () => {
  const db = new PGlite();
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0 });
  await server.start();
  const client = new Client({
    connectionString: `postgresql://postgres:postgres@${server.getServerConn()}/postgres`,
  });
  await client.connect();
  await client.query('BEGIN');
  const closing = closeSocketDatabase(server);
  try {
    await setImmediate();
    expect(db.closed).toBe(false);
    expect(server.getStats().activeConnections).toBe(1);
  } finally {
    await client.end();
    await closing;
  }
  expect(db.closed).toBe(true);
});
