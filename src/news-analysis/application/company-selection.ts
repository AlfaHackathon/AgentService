import type { FlowCheckpoint, FlowRequest, NewsPlan } from '../contracts/flow.ts';
import type { FlowContextClient } from '../retrieval/flow-clients.ts';
import type { NewsAnalyzer } from './company-analysis.ts';
export async function selectCompanies(
  context: FlowContextClient,
  analyzer: NewsAnalyzer,
  request: FlowRequest,
  checkpoint: FlowCheckpoint,
  plan: NewsPlan,
) {
  const ranks = new Map<string, number>();
  for (const query of request.targetCompanyIds.length || request.projectionOnly
    ? []
    : plan.queries) {
    const found = await context.search(query, request.asOf);
    found.hits.forEach((h, rank) => {
      ranks.set(
        h.companyId.toLowerCase(),
        (ranks.get(h.companyId.toLowerCase()) ?? 0) + 1 / (60 + rank + 1),
      );
    });
  }
  const candidates = [...ranks].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const groupIds = request.groupIds.length
    ? request.groupIds
    : (await context.groups(request.asOf)).map((g) => g.groupId);
  const groups = [];
  for (const id of groupIds) {
    const group = await context.expand(id, request.asOf);
    if (request.groupIds.includes(id) || group.companyIds.some((c) => ranks.has(c.toLowerCase())))
      groups.push(group);
  }
  checkpoint.groups = groups;
  const explicitRoles = request.personIds.length
    ? (await context.roles(request.asOf)).filter((role) =>
        request.personIds.includes(role.personId),
      )
    : [];
  const all = request.targetCompanyIds.length
    ? [...request.targetCompanyIds]
    : [
        ...new Set([
          ...request.targetCompanyIds,
          ...groups.flatMap((g) => g.companyIds.map((id) => id.toLowerCase())),
          ...explicitRoles.flatMap((role) => role.allowedCompanyIds.map((id) => id.toLowerCase())),
          ...candidates,
        ]),
      ];
  const previous = request.targetCompanyIds.length
    ? { companyIds: [], nextCursor: null }
    : await analyzer.recipients(request.asOf);
  all.push(...previous.companyIds.filter((id) => !all.includes(id)));
  checkpoint.recipientCursor = previous.nextCursor;
  checkpoint.selectedCompanyIds = all.slice(0, request.companyBudget);
  checkpoint.pendingCompanyIds = all.slice(request.companyBudget);
}
