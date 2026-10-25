import { z } from 'zod';
import {
  type AnalysisRequest,
  type AnalysisWrite,
  analysisReceiptSchema,
  draftSchema,
  effectsResponseSchema,
  responseCalculationSchema,
} from '../contracts/analysis.ts';
import { validateUniqueBusinessQuestions } from '../contracts/business-questions.ts';
import { parseResponse, ServiceClient } from '../transport/http/service-client.ts';

export class InsightClient {
  readonly http: ServiceClient;

  constructor(baseUrl: string, secret: string, fetcher = fetch) {
    this.http = new ServiceClient(baseUrl, secret, fetcher);
  }

  async analysisSession(input: AnalysisRequest) {
    return parseResponse(
      z.object({
        receipt: analysisReceiptSchema.nullable(),
        previousEffects: effectsResponseSchema.shape.effects,
        stateVersion: z.number().int().nonnegative().optional().nullable(),
      }),
      await this.http.request('/internal/analyses/session', { ...input, drafts: [] }),
    );
  }
  async prepare(
    request: AnalysisRequest,
    drafts: import('../contracts/analysis.ts').EffectDraft[],
    expectedStateVersion?: number,
  ): Promise<AnalysisWrite['drafts']> {
    validateUniqueBusinessQuestions(drafts);
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
  async saveAnalysis(input: AnalysisWrite) {
    validateUniqueBusinessQuestions(input.drafts);
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
