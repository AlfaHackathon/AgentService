import type { z } from 'zod';
import type { materialSchema, sourceRefSchema } from '../news-analysis/contracts/analysis.ts';
import { validateCompanyImportanceEvidence } from '../news-analysis/contracts/company-importance.ts';
import { instantAfter } from '../news-analysis/contracts/timestamps.ts';
import { sourceKey } from '../news-analysis/retrieval/source-catalog.ts';
import { projectIndicators, unavailableIndicators } from './indicators.ts';
import {
  type FeedQuery,
  generalCardSchema,
  generalReadSchema,
  personalCardSchema,
  personalReadSchema,
  publicFeedSchema,
  publicHistorySchema,
  publicRevisionSchema,
  readPage,
  type StoredRevision,
  sourceMetadataSchema,
  storedRevisionSchema,
} from './schemas.ts';

type Material = z.infer<typeof materialSchema>;
type Ref = z.infer<typeof sourceRefSchema>;
type Membership = { id: string; name: string; bankProfileId: string | null };
export type InsightReadDependencies = {
  membership: (userId: string) => Promise<Membership | null>;
  material: (id: string, version: string) => Promise<Material | null>;
  read: (path: string) => Promise<unknown>;
};
export class InsightReadError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InsightReadError';
  }
}
class SourceDenied extends Error {}
const key = (ref: Ref) => JSON.stringify([ref.materialId, ref.versionId]);
const notFound = () => new InsightReadError(404, 'INSIGHT_NOT_FOUND', 'Insight not found.');
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new InsightReadError(
      502,
      'INSIGHT_READ_CONTRACT',
      'The read service returned incompatible data.',
    );
  return result.data;
}
function safeUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}
function publicRevision(revision: StoredRevision) {
  const { impact, companyImportance } = revision;
  return parse(publicRevisionSchema, {
    category: revision.category ?? null,
    publicationClass: revision.publicationClass,
    trigger: revision.trigger,
    assessment: revision.assessment,
    question: revision.question,
    newsMaterialId: revision.newsMaterialId,
    revisionId: revision.revisionId,
    previousRevisionId: revision.previousRevisionId,
    newsVersionId: revision.newsVersionId,
    asOf: revision.asOf,
    conclusion: revision.conclusion,
    status: revision.status,
    sourceRefs: revision.sourceRefs,
    createdAt: revision.createdAt,
    companyImportance: companyImportance ?? null,
    impact: impact
      ? {
          metric: impact.metric,
          amountBasis: impact.amountBasis,
          economicObjectId: impact.economicObjectId,
          evidenceStatus: impact.evidenceStatus,
        }
      : null,
  });
}

export class InsightReadService {
  private readonly materials = new Map<string, Material>();
  constructor(private readonly dependencies: InsightReadDependencies) {}
  private async scope(userId: string) {
    const membership = await this.dependencies.membership(userId);
    if (!membership)
      throw new InsightReadError(
        403,
        'COMPANY_MEMBERSHIP_REQUIRED',
        'Current company membership is required.',
      );
    return { ...membership, id: membership.id.toLowerCase() };
  }
  private async load(refs: Ref[]) {
    const unique = [...new Map(refs.map((ref) => [key(ref), ref])).values()].filter(
      (ref) => !this.materials.has(key(ref)),
    );
    if (this.materials.size + unique.length > 64)
      throw new InsightReadError(
        503,
        'SOURCE_READ_BUDGET',
        'The source verification budget was exceeded; reduce the page size.',
      );
    for (let i = 0; i < unique.length; i += 4)
      await Promise.all(
        unique.slice(i, i + 4).map(async (ref) => {
          const material = await this.dependencies.material(ref.materialId, ref.versionId);
          if (!material)
            throw new InsightReadError(
              503,
              'SOURCE_UNAVAILABLE',
              'An exact source version is unavailable; no empty result is implied.',
            );
          this.materials.set(key(ref), material);
        }),
      );
  }
  private source(ref: Ref, scope: Membership, asOf: string, publicOnly = false) {
    const source = this.materials.get(key(ref));
    if (!source || sourceKey(source) !== sourceKey(ref) || instantAfter(source.knownAt, asOf))
      throw new InsightReadError(
        502,
        'SOURCE_IDENTITY_MISMATCH',
        'Source identity, hash or knowledge time does not match the saved revision.',
      );
    const companies = source.companyIds.map((id) => id.toLowerCase());
    const permittedCompany =
      companies.includes(scope.id) ||
      ((source.kind === 'news' || source.kind === 'market') && companies.length === 0);
    const permittedBank =
      source.bankProfileIds.length === 0 ||
      (scope.bankProfileId !== null && source.bankProfileIds.includes(scope.bankProfileId));
    if (
      !permittedCompany ||
      !permittedBank ||
      (publicOnly &&
        (companies.length !== 0 || source.bankProfileIds.length !== 0 || source.kind === 'company'))
    )
      throw new SourceDenied();
    return source;
  }
  private metadata(material: Material) {
    const provenance = material.provenance;
    return parse(sourceMetadataSchema, {
      materialId: material.materialId,
      versionId: material.versionId,
      contentHash: material.contentHash,
      sourceId: material.sourceId,
      kind: material.kind,
      title: material.title,
      knownAt: material.knownAt,
      publishedAt: material.publishedAt ?? null,
      provenance: provenance
        ? {
            acquisition: provenance.acquisition,
            sourceUrl: safeUrl(provenance.sourceUrl),
            retrievedAt: provenance.retrievedAt,
            textCompleteness: provenance.textCompleteness,
            originVersionId: provenance.originVersionId,
          }
        : null,
    });
  }
  private personal(item: z.infer<typeof personalReadSchema>, scope: Membership) {
    if (item.companyId.toLowerCase() !== scope.id)
      throw new InsightReadError(
        502,
        'INSIGHT_SCOPE_MISMATCH',
        'The read service changed company scope.',
      );
    const sources = item.currentRevision.sourceRefs.map((ref) =>
      this.source(ref, scope, item.currentRevision.asOf),
    );
    const revision = item.currentRevision;
    try {
      validateCompanyImportanceEvidence(
        {
          companyImportance: revision.companyImportance ?? undefined,
          sourceRefs: revision.sourceRefs,
          impact: revision.impact ?? undefined,
        },
        sources.filter(
          (s) => s.kind === 'company' && s.companyIds.some((id) => id.toLowerCase() === scope.id),
        ),
      );
    } catch {
      throw new InsightReadError(
        502,
        'IMPORTANCE_EVIDENCE_MISMATCH',
        'The stored company importance has incompatible evidence.',
      );
    }
    return parse(personalCardSchema, {
      kind: 'personal',
      id: item.id,
      companyId: scope.id,
      newsMaterialId: item.newsMaterialId,
      literalObjectRef: item.literalObjectRef,
      currentRevision: publicRevision(revision),
      requiresReassessment: item.requiresReassessment,
      sources: sources.map((s) => this.metadata(s)),
      ...projectIndicators(revision, item.requiresReassessment, sources, scope.id),
    });
  }
  private general(item: z.infer<typeof generalReadSchema>, scope: Membership) {
    if (item.companyId.toLowerCase() !== scope.id)
      throw new InsightReadError(
        502,
        'INSIGHT_SCOPE_MISMATCH',
        'The read service changed company scope.',
      );
    const sources = item.insight.sourceRefs.map((ref) => this.source(ref, scope, item.asOf, true));
    if (
      !sources.some(
        (source) =>
          source.kind === 'news' &&
          source.materialId === item.newsMaterialId &&
          source.versionId === item.newsVersionId,
      )
    )
      throw new InsightReadError(
        502,
        'GENERAL_NEWS_ANCHOR',
        'The stored general result has no exact public news anchor.',
      );
    return parse(generalCardSchema, {
      kind: 'general',
      id: item.id,
      companyId: scope.id,
      newsMaterialId: item.newsMaterialId,
      newsVersionId: item.newsVersionId,
      asOf: item.asOf,
      updatedAt: item.updatedAt,
      textCompleteness: item.textCompleteness,
      companyStatus: item.companyStatus,
      requiresReassessment: null,
      insight: {
        category: item.insight.category ?? null,
        signalIds: item.insight.signalIds,
        quality: item.insight.quality,
        title: item.insight.title,
        conclusion: item.insight.conclusion,
        mechanism: item.insight.mechanism,
        applicability: item.insight.applicability,
        exclusions: item.insight.exclusions,
        unknowns: item.insight.unknowns,
        sourceRefs: item.insight.sourceRefs,
      },
      sources: sources.map((s) => this.metadata(s)),
      ...unavailableIndicators('general_not_company_calculation'),
    });
  }
  async feed(userId: string, query: FeedQuery) {
    const scope = await this.scope(userId);
    const params = new URLSearchParams({ limit: String(query.limit) });
    for (const [name, value] of Object.entries(query))
      if (name !== 'kind' && name !== 'limit' && value !== undefined)
        params.set(name, String(value));
    const raw = await this.dependencies.read(
      `/internal/read/companies/${scope.id}/${query.kind}?${params}`,
    );
    if (raw === null)
      throw new InsightReadError(
        503,
        'INSIGHT_READ_UNAVAILABLE',
        'The scoped read service is not available; this is not an empty feed.',
      );
    const page =
      query.kind === 'personal'
        ? parse(readPage(personalReadSchema), raw)
        : parse(readPage(generalReadSchema), raw);
    if (page.companyId.toLowerCase() !== scope.id)
      throw new InsightReadError(
        502,
        'INSIGHT_SCOPE_MISMATCH',
        'The read service changed company scope.',
      );
    const personalItems =
      query.kind === 'personal' ? parse(readPage(personalReadSchema), raw).items : [];
    const generalItems =
      query.kind === 'general' ? parse(readPage(generalReadSchema), raw).items : [];
    if (
      [...personalItems, ...generalItems].some((item) => item.companyId.toLowerCase() !== scope.id)
    )
      throw new InsightReadError(
        502,
        'INSIGHT_SCOPE_MISMATCH',
        'The read service changed company scope.',
      );
    await this.load([
      ...personalItems.flatMap((i) => i.currentRevision.sourceRefs),
      ...generalItems.flatMap((i) => i.insight.sourceRefs),
    ]);
    const items = [];
    for (const item of personalItems) {
      try {
        items.push(this.personal(item, scope));
      } catch (error) {
        if (!(error instanceof SourceDenied)) throw error;
      }
    }
    for (const item of generalItems) {
      try {
        items.push(this.general(item, scope));
      } catch (error) {
        if (!(error instanceof SourceDenied)) throw error;
      }
    }
    return parse(publicFeedSchema, {
      companyId: scope.id,
      items,
      nextCursor: page.nextCursor,
      exhaustive: false,
    });
  }
  async detail(userId: string, kind: 'personal' | 'general', id: string) {
    const scope = await this.scope(userId);
    const raw = await this.dependencies.read(
      `/internal/read/companies/${scope.id}/${kind}/${encodeURIComponent(id)}`,
    );
    if (raw === null) throw notFound();
    try {
      if (kind === 'personal') {
        const item = parse(personalReadSchema, raw);
        if (item.id !== id || item.companyId.toLowerCase() !== scope.id) throw notFound();
        await this.load(item.currentRevision.sourceRefs);
        return this.personal(item, scope);
      }
      const item = parse(generalReadSchema, raw);
      if (item.id !== id || item.companyId.toLowerCase() !== scope.id) throw notFound();
      await this.load(item.insight.sourceRefs);
      return this.general(item, scope);
    } catch (error) {
      if (error instanceof SourceDenied) throw notFound();
      throw error;
    }
  }
  async history(userId: string, id: string, query: { limit: number; cursor?: string | undefined }) {
    const scope = await this.scope(userId);
    const prefix = `/internal/read/companies/${scope.id}/personal/${encodeURIComponent(id)}`;
    const currentRaw = await this.dependencies.read(prefix);
    if (currentRaw === null) throw notFound();
    const current = parse(personalReadSchema, currentRaw);
    if (current.id !== id || current.companyId.toLowerCase() !== scope.id) throw notFound();
    const params = new URLSearchParams({ limit: String(query.limit) });
    if (query.cursor) params.set('cursor', query.cursor);
    const raw = await this.dependencies.read(`${prefix}/history?${params}`);
    if (raw === null) throw notFound();
    const page = parse(readPage(storedRevisionSchema), raw);
    if (page.companyId.toLowerCase() !== scope.id)
      throw new InsightReadError(
        502,
        'INSIGHT_SCOPE_MISMATCH',
        'The read service changed company scope.',
      );
    await this.load([
      ...current.currentRevision.sourceRefs,
      ...page.items.flatMap((r) => r.sourceRefs),
    ]);
    try {
      this.personal(current, scope);
      const items = page.items.map((revision) => {
        const card = this.personal({ ...current, currentRevision: revision }, scope);
        return {
          revision: card.currentRevision,
          sources: card.sources,
          indicators: card.indicators,
          indicatorAvailability: card.indicatorAvailability,
        };
      });
      return parse(publicHistorySchema, {
        companyId: scope.id,
        insightId: id,
        items,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (error instanceof SourceDenied) throw notFound();
      throw error;
    }
  }
}
