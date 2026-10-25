import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../chats/routes.ts';
import { NewsAnalysisError } from '../news-analysis/contracts/errors.ts';
import { createInsightReadDependencies } from './configuration.ts';
import {
  feedQuerySchema,
  historyQuerySchema,
  insightIdSchema,
  insightKindSchema,
} from './schemas.ts';
import { type InsightReadDependencies, InsightReadError, InsightReadService } from './service.ts';

function query(c: Context<AppEnv>) {
  const result: Record<string, string> = Object.create(null);
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (values.length !== 1)
      throw new InsightReadError(
        400,
        'INVALID_QUERY',
        'Repeated query parameters are not accepted.',
      );
    result[key] = values[0] ?? '';
  }
  return result;
}

// Resolve current membership and source scope afresh on every read, including history.
export function createInsightReadRoutes(
  dependencies: () => InsightReadDependencies = createInsightReadDependencies,
) {
  const router = new Hono<AppEnv>();
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  router.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ code: 'INVALID_REQUEST', message: 'Invalid insight read request.' }, 400);
    if (error instanceof InsightReadError)
      return c.json({ code: error.code, message: error.message }, error.status);
    // Internal upstream messages, paths and service credentials never reach the client.
    if (error instanceof NewsAnalysisError && error.status === 400)
      return c.json({ code: 'INVALID_CURSOR', message: 'Invalid read cursor or filters.' }, 400);
    return c.json(
      { code: 'INSIGHT_READ_UNAVAILABLE', message: 'Insight reading is temporarily unavailable.' },
      503,
    );
  });
  router.get('/', async (c) => {
    const input = feedQuerySchema.parse(query(c));
    return c.json(await new InsightReadService(dependencies()).feed(c.get('userId'), input));
  });
  router.get('/personal/:id/history', async (c) => {
    const id = insightIdSchema.parse(c.req.param('id'));
    const input = historyQuerySchema.parse(query(c));
    return c.json(await new InsightReadService(dependencies()).history(c.get('userId'), id, input));
  });
  router.get('/:kind/:id', async (c) => {
    const kind = insightKindSchema.parse(c.req.param('kind'));
    const id = insightIdSchema.parse(c.req.param('id'));
    z.strictObject({}).parse(query(c));
    return c.json(await new InsightReadService(dependencies()).detail(c.get('userId'), kind, id));
  });
  return router;
}
