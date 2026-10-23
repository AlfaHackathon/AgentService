import { createAgentRouter } from '@flue/runtime/routing';
import { ClientAssistantAgent } from './agents/client-assistant.ts';
import { createApplication, mountService } from './application.ts';
import { ChatRepository } from './chats/repository.ts';
import { readEnvironment } from './config/environment.ts';
import { pool } from './db.ts';
import { createConfiguredNewsAnalysis } from './news-analysis/composition/configuration.ts';
import { readSql } from './shared/read-sql.ts';

readEnvironment();
const readinessSql = readSql('connection/ready.sql');
const newsAnalysis = createConfiguredNewsAnalysis();
export const stopNewsAnalysis = async () => newsAnalysis?.stop?.();

export default mountService(
  createApplication({
    chats: new ChatRepository(pool),
    agentRouter: createAgentRouter(ClientAssistantAgent),
    newsAnalysis,
    ready: async () => {
      await pool.query(readinessSql);
    },
  }),
  process.env.PUBLIC_ORIGIN,
);
