import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { NewsAnalyzer } from '../../application/company-analysis.ts';
import type { NewsFlow } from '../../application/news-flow.ts';
import { analysisRequestSchema } from '../../contracts/analysis.ts';
import { NewsAnalysisError } from '../../contracts/errors.ts';
import type { NewsKafkaConsumer } from '../kafka/consumer.ts';

export type NewsAnalysisRouteOptions = {
  internalSecret: string;
  analyzer: NewsAnalyzer;
  flow?: NewsFlow;
  kafka?: NewsKafkaConsumer;
  ready?: () => void;
  stop?: () => Promise<void>;
};

export function hasInternalSecret(expected: string, provided: string | null): boolean {
  if (!expected.trim() || !provided || provided.length > 4096) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createNewsAnalysisRoutes(options?: NewsAnalysisRouteOptions) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (!options?.internalSecret.trim())
      return c.json(
        { code: 'NEWS_ANALYSIS_DISABLED', message: 'Internal news analysis is not configured' },
        503,
      );
    if (!hasInternalSecret(options.internalSecret, c.req.header('X-Internal-Secret') ?? null))
      return c.json({ code: 'FORBIDDEN', message: 'Internal admission required' }, 403);
    return next();
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 65536,
      onError: (c) => c.json({ code: 'REQUEST_TOO_LARGE', message: 'Request exceeds 64 KiB' }, 413),
    }),
  );
  app.get('/kafka', (c) => c.json(options?.kafka?.status() ?? { status: 'disabled' }));
  app.post('/news', async (c) => {
    try {
      if (!options?.flow)
        return c.json(
          { code: 'NEWS_FLOW_DISABLED', message: 'News discovery is not configured' },
          503,
        );
      const job = await options.flow.enqueue(await c.req.json());
      return c.json(
        {
          jobId: job.request.jobId,
          status: job.status,
          statusUrl: `/agent-service/internal/news-analysis/jobs/${job.request.jobId}`,
        },
        202,
      );
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return c.json({ code: 'INVALID_REQUEST', message: 'Invalid news flow request' }, 400);
      if (error instanceof NewsAnalysisError)
        return c.json({ code: error.code, message: error.message }, error.status);
      return c.json({ code: 'NEWS_FLOW_FAILED', message: 'Could not enqueue news analysis' }, 502);
    }
  });
  app.post('/events', async (c) => {
    try {
      if (!options?.flow)
        return c.json(
          { code: 'NEWS_FLOW_DISABLED', message: 'News discovery is not configured' },
          503,
        );
      const job = await options.flow.ingest(await c.req.json());
      return c.json({ jobId: job.request.jobId, status: job.status }, 202);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return c.json({ code: 'INVALID_REQUEST', message: 'Invalid news event' }, 400);
      if (error instanceof NewsAnalysisError)
        return c.json({ code: error.code, message: error.message }, error.status);
      return c.json({ code: 'NEWS_EVENT_FAILED', message: 'Could not ingest news event' }, 502);
    }
  });
  app.get('/jobs/:jobId', async (c) => {
    try {
      if (!options?.flow)
        return c.json(
          { code: 'NEWS_FLOW_DISABLED', message: 'News discovery is not configured' },
          503,
        );
      return c.json(await options.flow.get(c.req.param('jobId')));
    } catch (error) {
      if (error instanceof NewsAnalysisError)
        return c.json({ code: error.code, message: error.message }, error.status);
      return c.json({ code: 'NEWS_FLOW_FAILED', message: 'Could not read news job' }, 502);
    }
  });
  app.post('/', async (c) => {
    try {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ code: 'INVALID_REQUEST', message: 'Invalid JSON' }, 400);
      }
      const input = analysisRequestSchema.parse(body);
      if (!options) throw new Error('Internal analysis not configured');
      return c.json(await options.analyzer.analyze(input));
    } catch (error) {
      if (error instanceof z.ZodError)
        return c.json({ code: 'INVALID_REQUEST', message: 'Invalid news analysis request' }, 400);
      if (error instanceof NewsAnalysisError)
        return c.json({ code: error.code, message: error.message }, error.status);
      return c.json({ code: 'NEWS_ANALYSIS_FAILED', message: 'News analysis failed' }, 502);
    }
  });
  return app;
}
