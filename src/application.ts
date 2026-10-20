import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { ChatRepository } from './chats/repository.ts';
import { type AppEnv, createChatRoutes, readJson } from './chats/routes.ts';
import { chatIdSchema, InvalidCursorError } from './chats/schema.ts';
import { readGatewayUserId } from './shared/identity.ts';

type ApplicationOptions = {
  chats: ChatRepository;
  agentRouter: Hono;
  ready: () => Promise<void>;
  log?: (entry: Record<string, unknown>) => void;
};

const userMessage = z.strictObject({
  kind: z.literal('user'),
  body: z
    .string()
    .min(1)
    .max(32000)
    .refine((value) => value.trim().length > 0),
  uid: z.string().min(1).max(256).nullable().optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
});

export function createApplication(options: ApplicationOptions) {
  const app = new Hono<AppEnv>();
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));

  app.use('*', async (c, next) => {
    const requestId = randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    const started = performance.now();
    await next();
    log({
      event: 'http.request',
      requestId,
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });
  app.use('*', bodyLimit({ maxSize: 65536 }));

  app.onError((error, c) => {
    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: 'Invalid request',
          issues: error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
        },
        400,
      );
    }
    if (error instanceof InvalidCursorError) return c.json({ error: 'Invalid cursor' }, 400);
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    log({ event: 'http.error', requestId: c.get('requestId'), errorType: error.name });
    return c.json({ error: 'Internal server error', requestId: c.get('requestId') }, 500);
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', async (c) => {
    try {
      await options.ready();
      return c.json({ status: 'ready' });
    } catch {
      return c.json({ status: 'unavailable' }, 503);
    }
  });

  app.use('*', async (c, next) => {
    const path = c.req.path.replace(/^\/agent-service(?=\/|$)/, '');
    if (
      !(path === '/chats' || path.startsWith('/chats/') || path.startsWith('/agents/assistant/'))
    ) {
      return next();
    }
    const userId = readGatewayUserId(c.req.raw.headers);
    if (!userId) throw new HTTPException(401, { message: 'Gateway user context required' });
    c.set('userId', userId);
    await next();
  });

  app.route('/chats', createChatRoutes(options.chats));

  app.use('/agents/assistant/:chatId/*', async (c, next) => {
    const chatId = chatIdSchema.parse(c.req.param('chatId'));
    const ownerId = c.get('userId');
    const chat = await options.chats.get(chatId, ownerId);
    if (!chat) throw new HTTPException(404, { message: 'Chat not found' });

    const path = c.req.path.replace(/^\/agent-service(?=\/|$)/, '');
    const sending = c.req.method === 'POST' && path.split('/').length === 4;
    if (sending) {
      if (chat.archivedAt) throw new HTTPException(409, { message: 'Chat is archived' });
      userMessage.parse(await readJson(c.req.raw.clone()));
    }
    await next();
    if (sending && c.res.status === 202) {
      try {
        const receipt: unknown = await c.res.clone().json();
        const parsed = z
          .object({ submissionId: z.string(), deduplicated: z.boolean().optional() })
          .safeParse(receipt);
        if (parsed.success) {
          log({
            event: 'agent.admitted',
            requestId: c.get('requestId'),
            agentName: 'client-assistant',
            conversationId: chatId,
            submissionId: parsed.data.submissionId,
          });
          if (parsed.data.deduplicated === true) return;
        }
      } catch {
        log({
          event: 'agent.receipt_unreadable',
          requestId: c.get('requestId'),
          conversationId: chatId,
        });
      }
      try {
        await options.chats.touch(chatId, ownerId);
      } catch {
        log({ event: 'chat.touch_failed', requestId: c.get('requestId'), conversationId: chatId });
      }
    }
  });
  app.route('/agents/assistant', options.agentRouter);
  return app;
}

// Gateway forwards service paths unchanged, as for /user-service and /auth-service.
export function mountService(application: ReturnType<typeof createApplication>) {
  const service = new Hono();
  service.route('/agent-service', application);
  return service;
}
