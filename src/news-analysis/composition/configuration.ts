import { NewsAnalyzer } from '../application/company-analysis.ts';
import { NewsFlow } from '../application/news-flow.ts';
import { SourceChangePump } from '../application/source-change-pump.ts';
import { createNativeNewsReasoner } from '../reasoning/company-reasoner.ts';
import { createFlowReasoner } from '../reasoning/flow-reasoner.ts';
import { ContextClient } from '../retrieval/context-client.ts';
import { FlowContextClient, FlowJobClient } from '../retrieval/flow-clients.ts';
import { InsightClient } from '../retrieval/insight-client.ts';
import type { NewsAnalysisRouteOptions } from '../transport/http/routes.ts';
import { serviceSettingsSchema } from '../transport/http/settings.ts';
import { createNewsKafkaConsumer } from '../transport/kafka/consumer.ts';

// Optional domain integration must not disable the existing chat service.
// Missing/invalid settings leave its internal route explicitly unavailable.
export function createConfiguredNewsAnalysis(
  environment: NodeJS.ProcessEnv = process.env,
): NewsAnalysisRouteOptions | undefined {
  const settings = serviceSettingsSchema.safeParse(environment);
  if (!settings.success) {
    if (environment.NEWS_KAFKA_ENABLED === 'true')
      throw new Error(
        'News Kafka requires configured ContextService, InsightService and internal admission',
      );
    return undefined;
  }
  const { INTERNAL_SECRET: secret, CONTEXT_SERVICE_URL, INSIGHT_SERVICE_URL } = settings.data;
  const analyzer = new NewsAnalyzer({
    context: new ContextClient(CONTEXT_SERVICE_URL, secret),
    insights: new InsightClient(INSIGHT_SERVICE_URL, secret),
    reasoner: createNativeNewsReasoner(environment),
  });
  const flow = new NewsFlow({
    context: new FlowContextClient(CONTEXT_SERVICE_URL, secret),
    jobs: new FlowJobClient(INSIGHT_SERVICE_URL, secret),
    analyzer,
    reasoner: createFlowReasoner(environment),
  });
  const changes = new SourceChangePump(
    new FlowContextClient(CONTEXT_SERVICE_URL, secret),
    new FlowJobClient(INSIGHT_SERVICE_URL, secret),
    analyzer,
    flow,
  );
  const kafka = createNewsKafkaConsumer(flow, environment);
  flow.start();
  changes.start();
  kafka?.start();
  return {
    internalSecret: secret,
    analyzer,
    flow,
    ...(kafka ? { kafka, ready: () => kafka.ready() } : {}),
    stop: async () => {
      changes.stop();
      await kafka?.stop();
      flow.stop();
    },
  };
}
