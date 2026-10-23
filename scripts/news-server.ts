import { start } from '@flue/runtime/node';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  CompanyConsequencesAgent,
  EvidenceRelevanceAgent,
  NewsPlannerAgent,
  RoleProjectionAgent,
  SegmentPlannerAgent,
  SegmentReviewAgent,
  SourceSignalsAgent,
  SourceSignalsReviewAgent,
} from '../src/agents/news-analysis.ts';
import { modelProvider } from '../src/config/model.ts';
import database from '../src/db.ts';
import { createConfiguredNewsAnalysis } from '../src/news-analysis/composition/configuration.ts';
import { createNewsAnalysisRoutes } from '../src/news-analysis/transport/http/routes.ts';

const runtime = await start({
  agents: [
    CompanyConsequencesAgent,
    NewsPlannerAgent,
    EvidenceRelevanceAgent,
    SourceSignalsAgent,
    SourceSignalsReviewAgent,
    SegmentPlannerAgent,
    SegmentReviewAgent,
    RoleProjectionAgent,
  ],
  providers: [modelProvider],
  db: database,
});
const options = createConfiguredNewsAnalysis();
if (!options) {
  await runtime.stop();
  throw new Error(
    'Set INTERNAL_SECRET, CONTEXT_SERVICE_URL, INSIGHT_SERVICE_URL and project LLM configuration',
  );
}
const app = new Hono();
app.get('/health', (c) => c.json({ service: 'agent-news-worker', status: 'ok' }));
app.get('/ready', (c) => {
  try {
    options.ready?.();
    return c.json({ status: 'ready' });
  } catch {
    return c.json({ status: 'unavailable' }, 503);
  }
});
app.route('/agent-service/internal/news-analysis', createNewsAnalysisRoutes(options));
const server = serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: Number(process.env.NEWS_WORKER_PORT ?? 5184),
});
console.log(JSON.stringify({ event: 'news.worker.listening', address: server.address() }));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    await options.stop?.();
    server.close(async () => {
      await runtime.stop();
      process.exit(0);
    });
  });
