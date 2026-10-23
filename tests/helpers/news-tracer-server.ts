// Controlled reasoning fixture for the three-process HTTP proof only.
// Context, source hashes, previous revisions and persistence use actual service clients.
import { Hono } from 'hono';
import { z } from 'zod';
import { NewsAnalyzer } from '../../src/news-analysis/application/company-analysis.ts';
import type { NewsReasoner } from '../../src/news-analysis/contracts/analysis.ts';
import { ContextClient } from '../../src/news-analysis/retrieval/context-client.ts';
import { InsightClient } from '../../src/news-analysis/retrieval/insight-client.ts';
import {
  createNewsAnalysisRoutes,
  hasInternalSecret,
} from '../../src/news-analysis/transport/http/routes.ts';
import { serviceSettingsSchema } from '../../src/news-analysis/transport/http/settings.ts';
import { createHttpService } from './http-service.ts';

const settings = serviceSettingsSchema.parse(process.env);
let calls = 0;
const reasoner: NewsReasoner = {
  async analyze(input) {
    calls++;
    if (input.request.newsVersionId === 'v3') return [];
    const rate = { v1: '450', v2: '360' }[input.request.newsVersionId];
    const contract = input.context.materials.find(
      (source) => source.materialId === 'local-contract-104',
    );
    if (!rate || !contract)
      throw new Error('Controlled fixture requires v1/v2 and local-contract-104');
    return [
      {
        effectKey: 'LOT-104',
        literalObjectRef: 'LOT-104',
        conclusion:
          'Synthetic planned cost increase for 104 units; no act or payment is confirmed.',
        status: 'forecast',
        sourceRefs: [input.context.news, contract].map(
          ({ materialId, versionId, contentHash }) => ({ materialId, versionId, contentHash }),
        ),
        calculation: {
          expression: {
            kind: 'multiply',
            left: {
              kind: 'subtract',
              left: { kind: 'value', value: rate },
              right: { kind: 'value', value: '300' },
            },
            right: { kind: 'value', value: '104' },
          },
          unit: 'RUB',
          period: 'Synthetic planned acceptance; no realized expense',
        },
      },
    ];
  },
};
const analyzer = new NewsAnalyzer({
  context: new ContextClient(settings.CONTEXT_SERVICE_URL, settings.INTERNAL_SECRET),
  insights: new InsightClient(settings.INSIGHT_SERVICE_URL, settings.INTERNAL_SECRET),
  reasoner,
});
const app = new Hono();
app.route(
  '/agent-service/internal/news-analysis',
  createNewsAnalysisRoutes({ internalSecret: settings.INTERNAL_SECRET, analyzer }),
);
app.get('/__test/reasoning-calls', (c) => {
  if (!hasInternalSecret(settings.INTERNAL_SECRET, c.req.header('X-Internal-Secret') ?? null))
    return c.json({ code: 'FORBIDDEN', message: 'Internal admission required' }, 403);
  return c.json({ calls, adapter: 'controlled_fixture_not_live_model' });
});
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.PORT ?? '5183');
const server = await createHttpService((request) => app.fetch(request), port);
console.log(
  JSON.stringify({
    event: 'test.tracer.ready',
    url: server.url,
    adapter: 'controlled_fixture_not_live_model',
  }),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
