import type { PGlite } from '@electric-sql/pglite';
import type { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { vi } from 'vitest';

type SocketDatabase = Pick<PGLiteSocketServer, 'getStats' | 'stop'> & {
  db: Pick<PGlite, 'close'>;
};

export async function closeSocketDatabase(server: SocketDatabase) {
  // Call after stopping the clients. stop() does not await the socket handlers'
  // deferred detach callbacks, which still need the WASM database to be alive.
  await vi.waitFor(
    () => {
      const { activeConnections, queuedQueries } = server.getStats();
      if (activeConnections || queuedQueries)
        throw new Error('Embedded database clients and queued work have not drained.');
    },
    { timeout: 5000, interval: 10 },
  );
  await server.stop();
  await server.db.close();
}
