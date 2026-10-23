import type { AnalysisRequest } from '../contracts/analysis.ts';
import { contextBundleSchema, materialSchema } from '../contracts/analysis.ts';
import { parseResponse, ServiceClient } from '../transport/http/service-client.ts';
export class ContextClient {
  readonly http: ServiceClient;

  constructor(baseUrl: string, secret: string, fetcher = fetch) {
    this.http = new ServiceClient(baseUrl, secret, fetcher);
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
    return parseResponse(
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
    return parseResponse(
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
    );
  }
}
