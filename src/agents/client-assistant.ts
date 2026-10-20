'use agent';

import { useProjectModel } from '../config/model.ts';
import { clientAssistantInstructions } from '../instructions/client-assistant.ts';

export function ClientAssistantAgent() {
  useProjectModel();
  return clientAssistantInstructions;
}
ClientAssistantAgent.agentName = 'client-assistant';
