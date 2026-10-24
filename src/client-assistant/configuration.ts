import { ChatRepository } from '../chats/repository.ts';
import { NewsAnalyzer } from '../news-analysis/application/company-analysis.ts';
import { createNativeNewsReasoner } from '../news-analysis/reasoning/company-reasoner.ts';
import { ContextClient } from '../news-analysis/retrieval/context-client.ts';
import { InsightClient } from '../news-analysis/retrieval/insight-client.ts';
import { ServiceClient } from '../news-analysis/transport/http/service-client.ts';
import { serviceSettingsSchema } from '../news-analysis/transport/http/settings.ts';
import { AssistantServiceClients } from './service-clients.ts';
import { type AssistantDependencies, AssistantToolError } from './session.ts';

export async function createAssistantDependencies(): Promise<AssistantDependencies> {
  const settings = serviceSettingsSchema.safeParse(process.env);
  if (!settings.success)
    throw new AssistantToolError(
      'ASSISTANT_NOT_CONFIGURED',
      'Company, Context and Insight service integration is not configured.',
    );
  const {
    INTERNAL_SECRET: secret,
    COMPANY_SERVICE_URL,
    CONTEXT_SERVICE_URL,
    INSIGHT_SERVICE_URL,
  } = settings.data;
  // Loaded only on a tool call; importing the agent does not start a second DB,
  // news worker, source-change pump or background model operation.
  const { pool } = await import('../db.ts');
  const chats = new ChatRepository(pool);
  return {
    owner: (id) => chats.owner(id),
    clients: new AssistantServiceClients(
      new ServiceClient(COMPANY_SERVICE_URL, secret),
      new ServiceClient(CONTEXT_SERVICE_URL, secret),
      new ServiceClient(INSIGHT_SERVICE_URL, secret),
    ),
    analyzer: new NewsAnalyzer({
      context: new ContextClient(CONTEXT_SERVICE_URL, secret),
      insights: new InsightClient(INSIGHT_SERVICE_URL, secret),
      reasoner: createNativeNewsReasoner(),
    }),
  };
}
