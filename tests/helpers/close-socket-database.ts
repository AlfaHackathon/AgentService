import { setImmediate } from 'node:timers/promises';
import type { PGlite } from '@electric-sql/pglite';
import type { PGLiteSocketServer } from '@electric-sql/pglite-socket';

type SocketDatabase = Pick<PGLiteSocketServer, 'stop'> & {
  db: Pick<PGlite, 'close'>;
};

export async function closeSocketDatabase(server: SocketDatabase) {
  // Call after stopping the clients. stop() awaits the net.Server close, but
  // pglite-socket schedules its socket-close cleanup with setImmediate. Drain
  // those already queued callbacks while the WASM database is still alive.
  await server.stop();
  await setImmediate();
  await server.db.close();
}
