import { setImmediate } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';
import { closeSocketDatabase } from './helpers/close-socket-database.ts';

it('waits for listener closure and deferred socket cleanup even when handler counts stay stale', async () => {
  const order: string[] = [];
  let closeListener: (() => void) | undefined;
  const server = {
    // pglite-socket can retain an error-detached handler in this counter.
    getStats: () => ({ activeConnections: 1, queuedQueries: 0, maxConnections: 1 }),
    stop: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          closeListener = () => {
            order.push('listener');
            void setImmediate().then(() => {
              order.push('socket cleanup');
            });
            resolve();
          };
        }),
    ),
    db: {
      close: vi.fn(async () => {
        order.push('database');
      }),
    },
  };
  const closing = closeSocketDatabase(server);
  await setImmediate();
  expect(order).toEqual([]);
  if (!closeListener) throw new Error('Missing listener close callback');
  closeListener();
  await closing;
  expect(order).toEqual(['listener', 'socket cleanup', 'database']);
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
  await client.end();
  await closeSocketDatabase(server);
  expect(db.closed).toBe(true);
});
