'use agent';

import { useInitialData } from '@flue/runtime';
import { useProjectModel } from '../config/model.ts';
import {
  useCompanyTools,
  useNewsPlannerTools,
  useRoleTools,
} from '../news-analysis/reasoning/tools/analysis.ts';
import {
  useEvidenceRelevanceTools,
  useSourceSignalReviewTools,
  useSourceSignalTools,
} from '../news-analysis/reasoning/tools/evidence.ts';
import type { AgentTask } from '../news-analysis/reasoning/tools/result.ts';
import { useSegmentTools } from '../news-analysis/reasoning/tools/segments.ts';

export function NewsPlannerAgent() {
  useProjectModel();
  const task = useInitialData<AgentTask>();
  useNewsPlannerTools(task);
  return task.instructions;
}
NewsPlannerAgent.agentName = 'news-planner';
NewsPlannerAgent.durability = { maxAttempts: 1, timeoutMs: 180000 };

export function CompanyConsequencesAgent() {
  useProjectModel();
  const task = useInitialData<AgentTask>();
  useCompanyTools(task);
  return task.instructions;
}
CompanyConsequencesAgent.agentName = 'company-consequences';
CompanyConsequencesAgent.durability = { maxAttempts: 1, timeoutMs: 180000 };

export function RoleProjectionAgent() {
  useProjectModel();
  const task = useInitialData<AgentTask>();
  useRoleTools(task);
  return task.instructions;
}
RoleProjectionAgent.agentName = 'role-projection';
RoleProjectionAgent.durability = { maxAttempts: 1, timeoutMs: 180000 };

export function SegmentPlannerAgent() {
  useProjectModel();
  const task = useInitialData<AgentTask>();
  useSegmentTools(task);
  return task.instructions;
}
SegmentPlannerAgent.agentName = 'news-segments';
SegmentPlannerAgent.durability = { maxAttempts: 1, timeoutMs: 360000 };

export function SegmentReviewAgent() {
  useProjectModel();
  const task = useInitialData<AgentTask>();
  useSegmentTools(task);
  return task.instructions;
}
SegmentReviewAgent.agentName = 'news-segment-review';
SegmentReviewAgent.durability = { maxAttempts: 1, timeoutMs: 360000 };

export function SourceSignalsAgent() {
  useProjectModel();
  const task = useInitialData<AgentTask>();
  useSourceSignalTools(task);
  return task.instructions;
}
SourceSignalsAgent.agentName = 'news-source-signals';
SourceSignalsAgent.durability = { maxAttempts: 1, timeoutMs: 360000 };

export function SourceSignalsReviewAgent() {
  useProjectModel();
  const task = useInitialData<AgentTask>();
  useSourceSignalReviewTools(task);
  return task.instructions;
}
SourceSignalsReviewAgent.agentName = 'news-source-signals-review';
SourceSignalsReviewAgent.durability = { maxAttempts: 1, timeoutMs: 360000 };

export function EvidenceRelevanceAgent() {
  useProjectModel();
  const task = useInitialData<AgentTask>();
  useEvidenceRelevanceTools(task);
  return task.instructions;
}
EvidenceRelevanceAgent.agentName = 'news-evidence-relevance';
EvidenceRelevanceAgent.durability = { maxAttempts: 1, timeoutMs: 180000 };
