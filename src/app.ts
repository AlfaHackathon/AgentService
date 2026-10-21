import { createAgentRouter } from '@flue/runtime/routing';
import { ClientAssistantAgent } from './agents/client-assistant.ts';
import { createApplication, mountService } from './application.ts';
import { ChatRepository } from './chats/repository.ts';
import { readEnvironment } from './config/environment.ts';
import { pool } from './db.ts';
import { readSql } from './shared/read-sql.ts';

readEnvironment();
const readinessSql = readSql('connection/ready.sql');

export default mountService(
  createApplication({
    chats: new ChatRepository(pool),
    agentRouter: createAgentRouter(ClientAssistantAgent),
    ready: async () => {
      await pool.query(readinessSql);
    },
  }),
  process.env.PUBLIC_ORIGIN,
);
