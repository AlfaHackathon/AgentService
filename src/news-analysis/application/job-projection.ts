import type { z } from 'zod';
import type { materialSchema } from '../contracts/analysis.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import type { FlowCheckpoint, FlowReasoner, FlowRequest, NewsPlan } from '../contracts/flow.ts';
import type { CompanyClient } from '../retrieval/company-client.ts';
import type { InsightDomainClient } from '../retrieval/insight-domain-client.ts';
import type { NewsAnalyzer } from './company-analysis.ts';
import { projectRoleView } from './role-projection.ts';

// Rebuild views from current canonical heads; never substitute job receipts for later revisions.
export async function projectJobResult(input: {
  companies: CompanyClient;
  projections: InsightDomainClient;
  analyzer: NewsAnalyzer;
  reasoner: FlowReasoner;
  request: FlowRequest;
  checkpoint: FlowCheckpoint;
  plan: NewsPlan;
  news: z.infer<typeof materialSchema>;
  selectedCompanyIds: string[];
  save: () => Promise<void>;
  ensureLease: () => void;
}) {
  const {
    companies,
    projections,
    analyzer,
    reasoner,
    request,
    checkpoint,
    plan,
    news,
    selectedCompanyIds,
    save,
    ensureLease,
  } = input;
  const {
    roles,
    missingPersonIds,
    companyIds: roleCompanyIds,
  } = await companies.roleScope(request.asOf, request.personIds, selectedCompanyIds);
  checkpoint.canonicalCompanies = [];
  const projectionRuns = [...checkpoint.companies];
  const additional = new Set([
    ...(checkpoint.groups ?? []).flatMap((g) => g.companyIds),
    ...roleCompanyIds,
  ]);
  for (const companyId of additional) {
    if (projectionRuns.some((c) => c.companyId === companyId)) continue;
    try {
      const receipt = await analyzer.readCompany({
        companyId,
        newsMaterialId: request.newsMaterialId,
        newsVersionId: request.newsVersionId,
        asOf: request.asOf,
      });
      projectionRuns.push({
        companyId,
        status: 'completed',
        receipt,
        contextComplete: receipt.contextComplete ?? false,
      });
    } catch {
      projectionRuns.push({ companyId, status: 'failed', error: 'NO_CANONICAL_STATE' });
    }
  }
  const canonical = await projections.canonicalFacts(projectionRuns, request.asOf);
  checkpoint.canonicalCompanies = canonical.companies;
  // Partial views are regenerated from the growing canonical company snapshot.
  checkpoint.roleViews = [];
  for (const role of roles) {
    ensureLease();
    const key = `${role.personId}:${role.companyId}:${role.revisionId}`;
    if (
      checkpoint.roleViews.some(
        (v) => typeof v === 'object' && v !== null && 'key' in v && v.key === key,
      )
    )
      continue;
    try {
      checkpoint.roleViews.push({
        key,
        ...(await projectRoleView(projections, reasoner, role, checkpoint, request)),
      });
    } catch (error) {
      checkpoint.roleViews.push({
        key,
        personId: role.personId,
        companyId: role.companyId,
        status: 'failed',
        error: error instanceof NewsAnalysisError ? error.code : 'ROLE_ANALYSIS_FAILED',
      });
    }
    await save();
  }
  const groupViews = await projections.groups(
    checkpoint.groups ?? [],
    checkpoint.canonicalCompanies,
    request.asOf,
  );
  checkpoint.result = {
    news: {
      materialId: news.materialId,
      versionId: news.versionId,
      contentHash: news.contentHash,
    },
    generalInsights: plan.generalInsights,
    segmentBatches: checkpoint.segmentBatches,
    segmentCoverageAvailable: !!reasoner.segments,
    unsegmentedCompanyIds: selectedCompanyIds.filter(
      (id) =>
        !checkpoint.segmentBatches.some((b) => b.segments.some((s) => s.companyIds.includes(id))),
    ),
    companies: checkpoint.companies,
    rankedCompanyFacts: canonical.facts,
    groups: groupViews,
    roles: checkpoint.roleViews,
    coverage: {
      selectedCompanies: selectedCompanyIds.length,
      pendingCompanyIds: checkpoint.pendingCompanyIds ?? [],
      failedCompanyIds: checkpoint.companies
        .filter((c) => c.status === 'failed')
        .map((c) => c.companyId),
      missingPersonIds,
      unrevisedEffectIds: checkpoint.companies.flatMap((c) => c.receipt?.unrevisedEffectIds ?? []),
      staleEffectIds: checkpoint.canonicalCompanies.flatMap((c) => c.staleEffectIds ?? []),
      discoveryExhaustive: false,
      newsTextCompleteness: request.textCompleteness,
      completeForSelectedScopes:
        request.textCompleteness === 'full' &&
        !checkpoint.pendingCompanyIds?.length &&
        !checkpoint.recipientCursor &&
        checkpoint.canonicalCompanies.every((c) => !c.staleEffectIds?.length) &&
        !missingPersonIds.length &&
        checkpoint.companies.every(
          (c) =>
            c.status === 'completed' &&
            c.contextComplete === true &&
            !c.receipt?.unrevisedEffectIds?.length,
        ) &&
        groupViews.every((g) => g.complete) &&
        checkpoint.roleViews.every(
          (v) => typeof v === 'object' && v !== null && 'status' in v && v.status === 'completed',
        ),
    },
  };
}
