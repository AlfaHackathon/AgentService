import { NewsAnalysisError } from '../contracts/errors.ts';
import type { FlowCheckpoint, FlowReasoner } from '../contracts/flow.ts';
import type { FlowJobClient } from '../retrieval/flow-clients.ts';

export async function projectJobResult(input: {
  jobId: string;
  jobs: FlowJobClient;
  reasoner: FlowReasoner;
  checkpoint: FlowCheckpoint;
  asOf: string;
  save: () => Promise<void>;
  ensureLease: () => void;
}) {
  const { jobId, jobs, reasoner, checkpoint, asOf, save, ensureLease } = input;
  await save(); // Insight reads the durable checkpoint, including the latest completed work.
  const prepared = await jobs.projection(jobId, !!reasoner.segments);
  checkpoint.canonicalCompanies = prepared.canonicalCompanies;
  checkpoint.roleViews = prepared.roleViews;
  const proposals: unknown[] = [];
  for (const scope of prepared.roleScopes) {
    ensureLease();
    try {
      const result = await reasoner.role(scope.profile, scope.facts, scope.groups, { asOf });
      proposals.push({
        ...result,
        key: scope.key,
        scopeVersion: scope.scopeVersion,
        status: 'proposed',
      });
    } catch (error) {
      proposals.push({
        key: scope.key,
        scopeVersion: scope.scopeVersion,
        error: error instanceof NewsAnalysisError ? error.code : 'ROLE_ANALYSIS_FAILED',
      });
    }
    const proposal = proposals.at(-1);
    checkpoint.roleViews = checkpoint.roleViews.filter(
      (view) =>
        !(typeof view === 'object' && view !== null && 'key' in view && view.key === scope.key),
    );
    checkpoint.roleViews.push(proposal);
    await save(); // Preserve model work; only Insight can validate and publish the role view.
  }
  const projection = await jobs.projection(jobId, !!reasoner.segments, proposals);
  checkpoint.canonicalCompanies = projection.canonicalCompanies;
  checkpoint.roleViews = projection.roleViews;
  checkpoint.result = projection.result;
}
