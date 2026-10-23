import { NewsAnalysisError } from '../contracts/errors.ts';
import {
  type FlowCheckpoint,
  type FlowReasoner,
  type FlowRequest,
  type RoleProfile,
  roleActionsSchema,
} from '../contracts/flow.ts';
import type { InsightDomainClient } from '../retrieval/insight-domain-client.ts';

export async function projectRoleView(
  projections: InsightDomainClient,
  reasoner: Pick<FlowReasoner, 'role'>,
  role: RoleProfile,
  checkpoint: FlowCheckpoint,
  request: FlowRequest,
) {
  const { profile, facts, groups } = await projections.role({
    personId: role.personId,
    companyId: role.companyId,
    asOf: request.asOf,
    groups: checkpoint.groups ?? [],
    companies: checkpoint.canonicalCompanies ?? checkpoint.companies,
  });
  if (!facts.length)
    return {
      ...profile,
      status: 'withheld',
      facts: [],
      actions: [],
      missingContext: ['No source-complete facts are available within this explicit read grant.'],
    };
  const response = roleActionsSchema.parse(
    await reasoner.role(profile, facts, groups, { asOf: request.asOf }),
  );
  const ids = new Set(facts.map((fact) => fact.effectId));
  if (response.actions.some((action) => action.effectIds.some((id) => !ids.has(id))))
    throw new NewsAnalysisError(
      422,
      'ROLE_FOREIGN_FACT',
      'A role action cites a fact outside the supplied projection',
    );
  return { ...profile, status: 'completed', facts, groups, ...response };
}
