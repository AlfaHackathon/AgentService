import type { z } from 'zod';
import type { materialSchema } from '../contracts/analysis.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import type { FlowCheckpoint, FlowReasoner, FlowRequest, NewsPlan } from '../contracts/flow.ts';
import { instantAfter } from '../contracts/timestamps.ts';
import type { FlowContextClient } from '../retrieval/flow-clients.ts';
import type { NewsAnalyzer } from './company-analysis.ts';
import { canonicalFacts, groupProjection, priority } from './projections.ts';
import { projectRoleView } from './role-projection.ts';

// Rebuild views from current canonical heads; never substitute job receipts for later revisions.
export async function projectJobResult(input: {
  context: FlowContextClient;
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
    context,
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
  const roles = (await context.roles(request.asOf)).filter((r) =>
    request.personIds.length
      ? request.personIds.includes(r.personId)
      : r.allowedCompanyIds.some((id) => selectedCompanyIds.includes(id)),
  );
  checkpoint.canonicalCompanies = [];
  const projectionRuns = [...checkpoint.companies];
  const additional = new Set([
    ...(checkpoint.groups ?? []).flatMap((g) => g.companyIds),
    ...roles.flatMap((r) => r.allowedCompanyIds),
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
  for (const run of projectionRuns) {
    if (!run.receipt || run.status !== 'completed') {
      checkpoint.canonicalCompanies.push(run);
      continue;
    }
    const state = await analyzer.currentEffects({
      companyId: run.companyId,
      newsMaterialId: request.newsMaterialId,
      newsVersionId: request.newsVersionId,
      asOf: request.asOf,
    });
    const heads = new Map(run.receipt.effects.map((e) => [e.effectId, e]));
    for (const effect of state) {
      const revision = [...effect.history]
        .reverse()
        .find((r) => !instantAfter(r.asOf, request.asOf));
      if (revision)
        heads.set(effect.effectId, {
          effectId: effect.effectId,
          revisionId: revision.revisionId,
          previousRevisionId: revision.previousRevisionId,
          duplicate: false,
          currentRevision: revision,
        });
    }
    checkpoint.canonicalCompanies.push({
      ...run,
      staleEffectIds: state.filter((e) => e.requiresReassessment).map((e) => e.effectId),
      receipt: { ...run.receipt, effects: [...heads.values()] },
    });
  }
  // Partial views are regenerated from the growing canonical company snapshot.
  checkpoint.roleViews = [];
  const missingPersonIds = request.personIds.filter(
    (id) => !roles.some((role) => role.personId === id),
  );
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
        ...(await projectRoleView(context, reasoner, role, checkpoint, request)),
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
  const groupViews = (checkpoint.groups ?? []).map((g) =>
    groupProjection(g, checkpoint.canonicalCompanies ?? checkpoint.companies),
  );
  const facts = canonicalFacts(checkpoint.canonicalCompanies ?? checkpoint.companies);
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
    rankedCompanyFacts: facts
      .map((f) => {
        const requiresReassessment =
          checkpoint.canonicalCompanies?.some((c) => c.staleEffectIds?.includes(f.effectId)) ??
          false;
        return {
          ...f,
          requiresReassessment,
          priority: requiresReassessment ? 0 : priority(f.revision),
        };
      })
      .sort((a, b) => b.priority - a.priority),
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
