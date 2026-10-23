import { z } from 'zod';
import {
  type AnalysisRequest,
  type AnalysisWrite,
  analysisReceiptSchema,
  draftSchema,
  effectsResponseSchema,
  responseCalculationSchema,
} from '../contracts/analysis.ts';
import { depthDecisionSchema, type evidenceInventorySchema } from '../contracts/depth.ts';
import { NewsAnalysisError } from '../contracts/errors.ts';
import type { FlowRequest, NewsPlan } from '../contracts/flow.ts';
import type { Relevance } from '../contracts/relevance.ts';
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
  async canonicalCompany(input: AnalysisRequest) {
    try {
      return parseResponse(
        analysisReceiptSchema,
        await this.http.request('/internal/analyses/canonical-company', input),
      );
    } catch (error) {
      if (error instanceof NewsAnalysisError && error.status === 422)
        throw new NewsAnalysisError(422, 'NO_CANONICAL_STATE', error.message);
      throw error;
    }
  }
  async applicability(input: AnalysisRequest) {
    try {
      return parseResponse(
        analysisReceiptSchema,
        await this.http.request('/internal/analyses/applicability', input),
      );
    } catch (error) {
      if (error instanceof NewsAnalysisError && error.status === 409)
        throw new NewsAnalysisError(409, 'DEPTH_ESCALATION_REQUIRED', error.message);
      throw error;
    }
  }
  async prepare(
    request: AnalysisRequest,
    drafts: import('../contracts/analysis.ts').EffectDraft[],
    expectedStateVersion?: number,
  ): Promise<AnalysisWrite['drafts']> {
    const preparedDraft = draftSchema.extend({
      expectedPreviousRevisionId: z.string().nullable(),
      calculation: responseCalculationSchema
        .optional()
        .nullable()
        .transform((value) => value ?? undefined),
      impact: draftSchema.shape.impact.nullable().transform((value) => value ?? undefined),
    });
    return parseResponse(
      z.object({ drafts: z.array(preparedDraft) }),
      await this.http.request('/internal/analyses/prepare', {
        request,
        drafts,
        expectedStateVersion,
      }),
    ).drafts;
  }
  async depth(input: {
    companyId: string;
    request: FlowRequest;
    plan: NewsPlan;
    inventory: z.infer<typeof evidenceInventorySchema>;
    hasProfile: boolean;
    newsCorrection: boolean;
    relevance?: Relevance;
  }) {
    return parseResponse(
      depthDecisionSchema,
      await this.http.request('/internal/analyses/depth', {
        ...input,
        request: { ...input.request, companyId: input.companyId },
      }),
    );
  }
  async validateApplicability(input: {
    companyId: string;
    asOf: string;
    candidates: {
      assessment: import('../contracts/analysis.ts').EffectDraft['assessment'];
      evidenceStatus: string;
      hasCalculation: boolean;
    }[];
  }) {
    return parseResponse(
      z.object({ valid: z.literal(true) }),
      await this.http.request('/internal/analyses/validate-applicability', input),
    );
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
    return parseResponse(
      z.object({ companyIds: z.array(z.uuid()), nextCursor: z.string().nullable() }),
      await this.http.request(`/internal/question-recipients?${query}`),
    );
  }
  async react(change: SourceChange, afterQuestion?: string | null) {
    return parseResponse(
      reactionPageSchema,
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
