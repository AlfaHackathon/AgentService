import { NewsAnalysisError } from '../contracts/errors.ts';
import {
  type FlowCheckpoint,
  type FlowReasoner,
  type FlowRequest,
  type RoleGroup,
  type RoleProfile,
  roleActionsSchema,
} from '../contracts/flow.ts';
import { instantAfter } from '../contracts/timestamps.ts';
import type { FlowContextClient } from '../retrieval/flow-clients.ts';
import { canonicalFacts, groupProjection, priority } from './projections.ts';
export async function projectRoleView(
  context: Pick<FlowContextClient, 'material'>,
  reasoner: Pick<FlowReasoner, 'role'>,
  role: RoleProfile,
  checkpoint: FlowCheckpoint,
  request: FlowRequest,
) {
  const allowed = new Set(role.allowedCompanyIds.map((x) => x.toLowerCase()));
  const canRead = async (refs: RoleProfile['sourceRefs']) => {
    for (const ref of refs) {
      const source = await context.material(ref.materialId, ref.versionId);
      if (
        source.contentHash !== ref.contentHash ||
        instantAfter(source.knownAt, request.asOf) ||
        (source.companyIds.length > 0 &&
          (!source.companyIds.every((id) => allowed.has(id.toLowerCase())) ||
            !role.allowedMaterialIds.includes(source.materialId)))
      )
        return false;
    }
    return true;
  };
  const facts = canonicalFacts(checkpoint.canonicalCompanies ?? checkpoint.companies).filter(
    (f) =>
      allowed.has(f.companyId.toLowerCase()) &&
      !(checkpoint.canonicalCompanies ?? checkpoint.companies).some((c) =>
        c.staleEffectIds?.includes(f.effectId),
      ),
  );
  const visible = [];
  for (const fact of facts) {
    if (await canRead(fact.revision.sourceRefs)) visible.push(fact);
  }
  const groups: RoleGroup[] = [];
  for (const group of checkpoint.groups ?? []) {
    if (!group.companyIds.every((id) => allowed.has(id.toLowerCase()))) continue;
    const projection = groupProjection(
      group,
      checkpoint.canonicalCompanies ?? checkpoint.companies,
    );
    // Unreviewed facts have no source-complete role projection yet.
    if (projection.coverage.unrevisedEffectIds.length) continue;
    const visibleIds = new Set(visible.map((fact) => fact.effectId));
    const members = new Set(group.companyIds.map((id) => id.toLowerCase()));
    if (
      facts.some(
        (fact) => members.has(fact.companyId.toLowerCase()) && !visibleIds.has(fact.effectId),
      ) ||
      !(await canRead(group.sourceRefs))
    )
      continue;
    groups.push(projection);
  }
  const profile = {
    personId: role.personId,
    companyId: role.companyId,
    role: role.role,
    responsibilities: role.responsibilities,
  };
  if (!visible.length)
    return {
      ...profile,
      status: 'withheld',
      facts: [],
      actions: [],
      missingContext: ['No source-complete facts are available within this explicit read grant.'],
    };
  const response = roleActionsSchema.parse(
    await reasoner.role(profile, visible, groups, { asOf: request.asOf }),
  );
  const ids = new Set(visible.map((f) => f.effectId));
  if (response.actions.some((a) => a.effectIds.some((id) => !ids.has(id))))
    throw new NewsAnalysisError(
      422,
      'ROLE_FOREIGN_FACT',
      'A role action cites a fact outside the permitted projection',
    );
  return {
    ...profile,
    status: 'completed',
    facts: visible.sort((a, b) => priority(b.revision) - priority(a.revision)),
    groups,
    ...response,
  };
}
