import { z } from 'zod';
import type { DeclaredCompanyContext } from '../contracts/declared-context.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import type { FlowCheckpoint, FlowReasoner } from '../contracts/flow.ts';
import type { FlowJobClient } from '../retrieval/flow-clients.ts';
import type { OwnerContextClient } from '../retrieval/owner-context.ts';

export async function projectJobResult(input: {
  jobId: string;
  jobs: FlowJobClient;
  reasoner: FlowReasoner;
  checkpoint: FlowCheckpoint;
  asOf: string;
  save: () => Promise<void>;
  ensureLease: () => void;
  owners?: Pick<OwnerContextClient, 'recipient' | 'company'>;
}) {
  const { jobId, jobs, reasoner, checkpoint, asOf, save, ensureLease } = input;
  await save(); // Insight reads the durable checkpoint, including the latest completed work.
  const prepared = await jobs.projection(jobId, !!reasoner.segments);
  checkpoint.canonicalCompanies = prepared.canonicalCompanies;
  checkpoint.roleViews = prepared.roleViews;
  const proposals: unknown[] = [];
  const companyContexts = new Map<string, Promise<DeclaredCompanyContext>>();
  for (const scope of prepared.roleScopes) {
    ensureLease();
    try {
      let profile: Parameters<FlowReasoner['role']>[0] = scope.profile;
      if (input.owners && z.uuid().safeParse(scope.profile.personId).success) {
        const recipient = await input.owners.recipient(
          scope.profile.personId,
          scope.profile.companyId,
          asOf,
        );
        if (recipient) {
          const key = JSON.stringify([scope.profile.companyId.toLowerCase(), asOf]);
          let company = companyContexts.get(key);
          if (!company) {
            company = input.owners.company(scope.profile.companyId, asOf);
            companyContexts.set(key, company);
          }
          profile = {
            ...structuredClone(scope.profile),
            role: recipient.viewer?.role?.name ?? scope.profile.role,
            recipientContext: {
              company: await company,
              recipient,
              knowledgeRole: scope.profile.role,
              usage: 'framing/actions only; no ACL/arithmetic',
            },
          };
          if (JSON.stringify(profile.recipientContext).length > 48000)
            throw new NewsAnalysisError(
              422,
              'DECLARED_CONTEXT_BUDGET',
              'Combined declared recipient framing exceeds its context budget; no source fields or canonical facts were truncated.',
            );
        }
      }
      const result = await reasoner.role(profile, scope.facts, scope.groups, { asOf });
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
