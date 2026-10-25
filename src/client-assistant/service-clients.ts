import { z } from 'zod';
import {
  analysisReceiptSchema,
  effectsResponseSchema,
  materialSchema,
  sourceRefSchema,
} from '../news-analysis/contracts/analysis.ts';
import { companyProfileSchema } from '../news-analysis/contracts/flow.ts';
import { timestampSchema } from '../news-analysis/contracts/timestamps.ts';
import {
  parseResponse,
  type ServiceClient,
} from '../news-analysis/transport/http/service-client.ts';

const membershipSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  bankProfileId: z
    .string()
    .regex(/^U_\d+$/)
    .nullable(),
});
const searchSchema = z.object({
  hits: z
    .array(
      z.object({
        companyId: z.uuid(),
        sourceRefs: z.array(sourceRefSchema).max(64),
        relatedVersions: z.array(sourceRefSchema).max(64).nullable().optional(),
        excerpt: z.string().nullable(),
      }),
    )
    .max(6),
  exhaustive: z.boolean(),
});

// This read-only catalog contract is a separately documented ContextService dependency.
// It searches admitted public news only, without embedding/rerank or URL acquisition.
const newsSearchSchema = z.object({
  asOf: timestampSchema,
  hits: z.array(materialSchema.omit({ text: true })).max(6),
  exhaustive: z.literal(false),
});

// Local typed service adapters; see docs/client-assistant-news-contract.md.
export class AssistantServiceClients {
  constructor(
    readonly company: ServiceClient,
    readonly context: ServiceClient,
    readonly insight: ServiceClient,
  ) {}

  async membership(ownerId: string) {
    return parseResponse(
      membershipSchema.nullable(),
      await this.company.request(
        `/internal/companies/by-user/${encodeURIComponent(ownerId)}`,
        undefined,
        true,
      ),
    );
  }

  async profile(companyId: string, asOf: string) {
    return parseResponse(
      companyProfileSchema,
      await this.company.request(
        `/internal/knowledge/companies/${companyId}?${new URLSearchParams({ asOf })}`,
      ),
    );
  }

  async search(companyId: string, query: string, asOf: string) {
    return parseResponse(
      searchSchema,
      await this.context.request(
        '/internal/search',
        {
          companyId,
          query,
          asOf,
          limit: 6,
          publicOnly: false,
        },
        false,
        120000,
      ),
    );
  }

  async material(materialId: string, versionId: string) {
    return parseResponse(
      materialSchema,
      await this.context.request(
        `/internal/material-versions/${encodeURIComponent(materialId)}/${encodeURIComponent(versionId)}`,
      ),
    );
  }

  async searchNews(query: string, asOf: string) {
    const payload = await this.context.request(
      '/internal/news/search',
      { query, asOf, limit: 6 },
      true,
    );
    return payload === null ? null : parseResponse(newsSearchSchema, payload);
  }

  async news(newsMaterialId: string, newsVersionId: string, asOf: string) {
    return parseResponse(
      materialSchema,
      await this.context.request('/internal/news/resolve', {
        newsMaterialId,
        newsVersionId,
        asOf,
      }),
    );
  }

  async effects(companyId: string, newsMaterialId: string, asOf: string) {
    return parseResponse(
      effectsResponseSchema,
      await this.insight.request(
        `/internal/effects?${new URLSearchParams({ companyId, newsMaterialId, asOf })}`,
      ),
    );
  }

  async receipt(
    companyId: string,
    newsMaterialId: string,
    newsVersionId: string,
    trigger?: { materialId: string; versionId: string },
  ) {
    return parseResponse(
      analysisReceiptSchema.nullable(),
      await this.insight.request(
        `/internal/analyses?${new URLSearchParams({
          companyId,
          newsMaterialId,
          newsVersionId,
          ...(trigger
            ? { triggerMaterialId: trigger.materialId, triggerVersionId: trigger.versionId }
            : {}),
        })}`,
        undefined,
        true,
      ),
    );
  }
}
