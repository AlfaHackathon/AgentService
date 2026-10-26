import type { AnalysisRequest, ContextBundle } from '../contracts/analysis.ts';
import { contextBundleSchema, materialSchema } from '../contracts/analysis.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import { isNonDocumentarySource } from '../contracts/source-policy.ts';
import { instantAfter } from '../contracts/timestamps.ts';
import { parseResponse, ServiceClient } from '../transport/http/service-client.ts';
export class ContextClient {
  readonly http: ServiceClient;
  readonly excludedSourceIds: readonly string[];

  constructor(
    baseUrl: string,
    secret: string,
    fetcher = fetch,
    excludedSourceIds: readonly string[] = process.env.NEWS_PAYMENT_SOURCE_ID
      ? [process.env.NEWS_PAYMENT_SOURCE_ID]
      : [],
  ) {
    this.http = new ServiceClient(baseUrl, secret, fetcher);
    this.excludedSourceIds = [...excludedSourceIds];
  }
  documentaryContext(
    bundle: ContextBundle,
    scope?: Pick<AnalysisRequest, 'companyId' | 'asOf'>,
  ): ContextBundle {
    const excluded = bundle.materials.filter((s) =>
      isNonDocumentarySource(s.sourceId, this.excludedSourceIds),
    );
    if (
      scope &&
      excluded.some(
        (source) =>
          source.kind !== 'company' ||
          !source.companyIds.includes(scope.companyId) ||
          instantAfter(source.knownAt, scope.asOf),
      )
    )
      throw new NewsAnalysisError(
        502,
        'UPSTREAM_CONTRACT',
        'Declared material is outside the fixed company and knowledge scope.',
      );
    if (!excluded.length && !bundle.nonDocumentarySources?.length) return bundle;
    const materials = bundle.materials.filter(
      (s) => !isNonDocumentarySource(s.sourceId, this.excludedSourceIds),
    );
    const refs = [
      ...(bundle.nonDocumentarySources ?? []),
      ...excluded.map(({ materialId, versionId, contentHash, sourceId }) => ({
        materialId,
        versionId,
        contentHash,
        sourceId,
      })),
    ];
    const nonDocumentarySources = [
      ...new Map(
        refs.map((ref) => [JSON.stringify([ref.materialId, ref.versionId, ref.contentHash]), ref]),
      ).values(),
    ];
    if (nonDocumentarySources.length > 256)
      throw new NewsAnalysisError(
        422,
        'DECLARED_CONTEXT_BUDGET',
        'Declared source metadata exceeds the context budget; no references were truncated.',
      );
    const characters = JSON.stringify({ news: bundle.news, materials }).length;
    return {
      ...bundle,
      materials,
      nonDocumentarySources,
      ...(bundle.retrieval
        ? {
            retrieval: {
              ...bundle.retrieval,
              selectedMaterials: materials.length,
              omittedMaterials: bundle.retrieval.omittedMaterials + excluded.length,
              exhaustive: false,
            },
          }
        : {}),
      coverage: {
        ...bundle.coverage,
        complete: false,
        materialCount: materials.length + 1,
        companyMaterialCount: materials.filter((s) => s.kind === 'company').length,
        marketMaterialCount: materials.filter((s) => s.kind === 'market').length,
        previousNewsVersionCount: materials.filter((s) => s.kind === 'news').length,
        characters,
        ...(bundle.coverage.budget
          ? { budget: { ...bundle.coverage.budget, usedCharacters: characters } }
          : {}),
      },
    };
  }

  async getContext(input: AnalysisRequest) {
    const {
      bankProfileId: _bankProfileId,
      retrievalQueries,
      retrievalLimit,
      mechanisms: _mechanisms,
      trigger: _trigger,
      ...request
    } = input;
    return this.documentaryContext(
      parseResponse(
        contextBundleSchema,
        await this.http.request(
          retrievalQueries ? '/internal/context/retrieve' : '/internal/context',
          retrievalQueries
            ? { ...request, queries: retrievalQueries, limit: retrievalLimit ?? 12 }
            : request,
          false,
          // Retrieval performs up to six embedding/rerank searches, with CPU inference
          // shared by parallel companies. Its budget differs from a stored-record read.
          retrievalQueries ? 120000 : 15000,
        ),
      ),
      input,
    );
  }
  async material(materialId: string, versionId: string) {
    return parseResponse(
      materialSchema,
      await this.http.request(
        `/internal/material-versions/${encodeURIComponent(materialId)}/${encodeURIComponent(versionId)}`,
      ),
    );
  }
  async followUp(
    input: AnalysisRequest,
    queries: string[],
    scope?: 'company' | 'market',
    requiredMaterialIds: string[] = [],
  ) {
    return this.documentaryContext(
      parseResponse(
        contextBundleSchema,
        await this.http.request(
          '/internal/context/retrieve',
          {
            companyId: input.companyId,
            newsMaterialId: input.newsMaterialId,
            newsVersionId: input.newsVersionId,
            asOf: input.asOf,
            queries,
            limit: 12,
            scope,
            requiredMaterialIds,
          },
          false,
          120000,
        ),
      ),
      input,
    );
  }
}
