'use agent';

import { useProjectModel } from '../config/model.ts';
import { companyResearchInstructions } from '../instructions/company-research.ts';

export function CompanyResearchAgent() {
  useProjectModel();
  return companyResearchInstructions;
}
CompanyResearchAgent.agentName = 'company-research';
