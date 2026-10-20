'use agent';

import { useProjectModel } from '../config/model.ts';
import { insightInstructions } from '../instructions/insight.ts';

export function InsightAgent() {
  useProjectModel();
  return insightInstructions;
}
InsightAgent.agentName = 'insight';
