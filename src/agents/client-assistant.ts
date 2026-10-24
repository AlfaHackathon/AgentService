'use agent';

import type { AgentProps } from '@flue/runtime';
import { useClientAssistantTools } from '../client-assistant/tools.ts';
import { useProjectModel } from '../config/model.ts';
import { clientAssistantInstructions } from '../instructions/client-assistant.ts';

export function ClientAssistantAgent({ id }: AgentProps) {
  useProjectModel();
  useClientAssistantTools(id);
  return clientAssistantInstructions;
}
ClientAssistantAgent.agentName = 'client-assistant';
