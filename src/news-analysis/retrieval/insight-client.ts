import { z } from 'zod';
import {
  type AnalysisRequest,
  type AnalysisWrite,
  analysisReceiptSchema,
  effectsResponseSchema,
} from '../contracts/analysis.ts';
import { reactionPageSchema, type SourceChange } from '../contracts/source-changes.ts';
import { parseResponse, ServiceClient } from '../transport/http/service-client.ts';

function analysisQuery(input: AnalysisRequest): string {
  return new URLSearchParams({
    companyId: input.companyId,
    newsMaterialId: input.newsMaterialId,
    newsVersionId: input.newsVersionId,
    ...(input.trigger
      ? { triggerMaterialId: input.trigger.materialId, triggerVersionId: input.trigger.versionId }
      : {}),
  }).toString();
}

export class InsightClient {
  readonly http: ServiceClient;

  constructor(baseUrl: string, secret: string, fetcher = fetch) {
    this.http = new ServiceClient(baseUrl, secret, fetcher);
  }

  async findAnalysis(input: AnalysisRequest) {
    const payload = await this.http.request(
      `/internal/analyses?${analysisQuery(input)}`,
      undefined,
      true,
    );
    return payload === null ? null : parseResponse(analysisReceiptSchema, payload);
  }

  async getEffects(input: AnalysisRequest) {
    return (await this.getState(input)).effects;
  }
  async getState(input: AnalysisRequest) {
    const query = new URLSearchParams({
      companyId: input.companyId,
      newsMaterialId: input.newsMaterialId,
      asOf: input.asOf,
    });
    return parseResponse(
      effectsResponseSchema.extend({ stateVersion: z.number().int().nonnegative().optional() }),
      await this.http.request(`/internal/effects?${query}`),
    );
  }
  async recipients(asOf: string, after?: string, materialId?: string) {
    const query = new URLSearchParams({
      asOf,
      ...(after ? { after } : {}),
      ...(materialId ? { materialId } : {}),
    });
    return z
      .object({ companyIds: z.array(z.uuid()), nextCursor: z.string().nullable() })
      .parse(await this.http.request(`/internal/question-recipients?${query}`));
  }
  async react(change: SourceChange, afterQuestion?: string | null) {
    return reactionPageSchema.parse(
      await this.http.request('/internal/source-changes', {
        ...change,
        afterQuestion: afterQuestion ?? null,
      }),
    );
  }

  async saveAnalysis(input: AnalysisWrite) {
    return parseResponse(
      analysisReceiptSchema,
      await this.http.request('/internal/analyses', input),
    );
  }

  async preview(drafts: import('../contracts/analysis.ts').EffectDraft[]) {
    return this.http.request(
      '/internal/calculations/preview',
      drafts.flatMap((d) => (d.calculation ? [d.calculation] : [])),
    );
  }
}
