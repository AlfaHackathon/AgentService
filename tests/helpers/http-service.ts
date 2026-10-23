import { once } from 'node:events';
import { createServer } from 'node:http';

export async function createHttpService(
  handler: (request: Request) => Promise<Response> | Response,
  port = 0,
) {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const headers = new Headers();
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index];
        const value = request.rawHeaders[index + 1];
        if (name && value) headers.append(name, value);
      }
      const result = await handler(
        new Request(`http://127.0.0.1${request.url}`, {
          method: request.method ?? 'GET',
          headers,
          ...(body ? { body } : {}),
        }),
      );
      result.headers.forEach((value, name) => {
        response.setHeader(name, value);
      });
      response.writeHead(result.status);
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 'TEST_SERVER_ERROR', message: 'Test handler failed' }));
    }
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
