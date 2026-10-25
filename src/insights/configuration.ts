import { AssistantServiceClients } from '../client-assistant/service-clients.ts';
import { ServiceClient } from '../news-analysis/transport/http/service-client.ts';
import { serviceSettingsSchema } from '../news-analysis/transport/http/settings.ts';
import { type InsightReadDependencies, InsightReadError } from './service.ts';

// Fresh clients/deadline per HTTP request; no chat state, DB, worker or model initialization.
export function createInsightReadDependencies(
  environment: NodeJS.ProcessEnv = process.env,
): InsightReadDependencies {
  const settings = serviceSettingsSchema.safeParse(environment);
  if (!settings.success)
    throw new InsightReadError(
      503,
      'INSIGHT_READ_NOT_CONFIGURED',
      'Insight reading is not configured.',
    );
  const s = settings.data;
  const company = new ServiceClient(s.COMPANY_SERVICE_URL, s.INTERNAL_SECRET);
  const context = new ServiceClient(s.CONTEXT_SERVICE_URL, s.INTERNAL_SECRET);
  const insight = new ServiceClient(s.INSIGHT_SERVICE_URL, s.INTERNAL_SECRET);
  const deadline = Date.now() + 15000;
  for (const client of [company, context, insight]) client.deadlineAt = deadline;
  const clients = new AssistantServiceClients(company, context, insight);
  return {
    membership: (id) => clients.membership(id),
    material: (mid, version) => clients.material(mid, version),
    read: (path) => insight.request(path, undefined, true),
  };
}
