import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { z } from 'zod';

const requestSchema = z.object({
  model: z.string(),
  stream: z.literal(true),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});

export async function createLlmServer() {
  const requests: z.infer<typeof requestSchema>[] = [];
  const pending = new Set<ServerResponse>();
  let allowSlowResponses = false;
  const server = createServer(async (req, res) => {
    try {
      if (
        req.url !== '/v1/chat/completions' ||
        req.headers.authorization !== 'Bearer test-only-key'
      ) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      requests.push(body);
      const users = body.messages
        .filter((message) => message.role === 'user')
        .map((message) => {
          if (typeof message.content === 'string') return message.content;
          return z
            .array(z.object({ type: z.literal('text'), text: z.string() }))
            .parse(message.content)
            .map((part) => part.text)
            .join('');
        });
      const last = users.at(-1) ?? '';
      if (last === 'fail') {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            error: { message: 'Test model refused the request', type: 'invalid_request_error' },
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const write = (delta: Record<string, unknown>, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: `completion-${requests.length}`,
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      write({ role: 'assistant', content: '' });
      if (last.startsWith('slow') && !allowSlowResponses) {
        pending.add(res);
        res.on('close', () => pending.delete(res));
        return;
      }
      write({ content: 'История: ' });
      write({ content: users.join(' | ') });
      write({}, 'stop');
      res.end('data: [DONE]\n\n');
    } catch {
      res.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test endpoint');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    allowSlowResponses: () => {
      allowSlowResponses = true;
    },
    close: async () => {
      for (const response of pending) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
