'use agent';

import { useProjectModel } from '../config/model.ts';
import { scenarioInstructions } from '../instructions/scenario.ts';

export function ScenarioAgent() {
  useProjectModel();
  return scenarioInstructions;
}
ScenarioAgent.agentName = 'scenario';
