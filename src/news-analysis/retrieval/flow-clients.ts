import { z } from 'zod';
import { materialSchema, sourceRefSchema } from '../contracts/analysis.ts';
import { evidenceInventorySchema } from '../contracts/depth.ts';
import {
  companyProfileSchema,
  type FlowCheckpoint,
  type FlowRequest,
  groupExpansionSchema,
  jobSchema,
  type NewsJob,
  roleProfileSchema,
} from '../contracts/flow.ts';
import { sourceChangeSchema, sourceCursorSchema } from '../contracts/source-changes.ts';
import { parseResponse, ServiceClient } from '../transport/http/service-client.ts';

const searchSchema = z.object({
  hits: z.array(
    z.object({
      companyId: z.uuid(),
      sourceRefs: z.array(sourceRefSchema),
      relatedVersions: z.array(sourceRefSchema).nullable().optional(),
      score: z.number(),
      materialId: z.string().nullable(),
      versionId: z.string().nullable(),
    }),
  ),
  mode: z.string(),
  reranker: z.string(),
  exhaustive: z.boolean(),
  candidatesExamined: z.number(),
});

export class FlowContextClient {
  readonly http: ServiceClient;
  constructor(url: string, secret: string, fetcher = fetch) {
    this.http = new ServiceClient(url, secret, fetcher);
  }
  async material(id: string, version: string) {
    return parseResponse(
      materialSchema,
      await this.http.request(
        `/internal/material-versions/${encodeURIComponent(id)}/${encodeURIComponent(version)}`,
      ),
    );
  }
  async saveMaterial(value: unknown) {
    return parseResponse(
      materialSchema,
      await this.http.request('/internal/material-versions', value),
    );
  }
  async companies(asOf: string) {
    return parseResponse(
      z.object({ companies: z.array(companyProfileSchema) }),
      await this.http.request(`/internal/companies?asOf=${encodeURIComponent(asOf)}`),
    ).companies;
  }
  async evidence(companyId: string, asOf: string) {
    return parseResponse(
      evidenceInventorySchema,
      await this.http.request(
        `/internal/companies/${encodeURIComponent(companyId)}/evidence?asOf=${encodeURIComponent(asOf)}`,
      ),
    );
  }
  async groups(asOf: string) {
    return parseResponse(
      z.object({ groups: z.array(z.object({ groupId: z.string() })) }),
      await this.http.request(`/internal/groups?asOf=${encodeURIComponent(asOf)}`),
    ).groups;
  }
  async expand(id: string, asOf: string) {
    return parseResponse(
      groupExpansionSchema,
      await this.http.request(
        `/internal/groups/${encodeURIComponent(id)}?asOf=${encodeURIComponent(asOf)}`,
      ),
    );
  }
  async roles(asOf: string) {
    return parseResponse(
      z.object({ roles: z.array(roleProfileSchema) }),
      await this.http.request(`/internal/roles?asOf=${encodeURIComponent(asOf)}`),
    ).roles;
  }
  async search(query: string, asOf: string, publicOnly = false) {
    return parseResponse(
      searchSchema,
      await this.http.request(
        '/internal/search',
        { query, asOf, limit: 48, publicOnly },
        false,
        120000,
      ),
    );
  }
  async sync() {
    return this.http.request('/internal/search/sync', {});
  }
  async changes(after: number) {
    return parseResponse(
      z.object({ changes: z.array(sourceChangeSchema) }),
      await this.http.request(`/internal/changes?after=${after}`),
    ).changes;
  }
}
export class FlowJobClient {
  readonly http: ServiceClient;
  constructor(url: string, secret: string, fetcher = fetch) {
    this.http = new ServiceClient(url, secret, fetcher);
  }
  async create(jobId: string, request: FlowRequest) {
    return parseResponse(
      jobSchema,
      await this.http.request('/internal/news-jobs', {
        jobId,
        newsMaterialId: request.newsMaterialId,
        newsVersionId: request.newsVersionId,
        asOf: request.asOf,
        parameters: request,
      }),
    );
  }
  async sourceCursor() {
    return parseResponse(sourceCursorSchema, await this.http.request('/internal/source-cursor'));
  }
  async advanceSourceCursor(cursor: z.infer<typeof sourceCursorSchema>) {
    return parseResponse(
      sourceCursorSchema,
      await this.http.request('/internal/source-cursor', cursor),
    );
  }
  async get(id: string) {
    return parseResponse(
      jobSchema,
      await this.http.request(`/internal/news-jobs/${encodeURIComponent(id)}`),
    );
  }
  async claim(workerId: string) {
    return parseResponse(
      jobSchema.nullable(),
      await this.http.request('/internal/news-jobs/claim', { workerId }),
    );
  }
  async update(
    job: NewsJob,
    checkpoint: FlowCheckpoint,
    status: 'running' | 'partial' | 'completed' | 'failed' = 'running',
    error?: string,
  ) {
    return parseResponse(
      jobSchema,
      await this.http.request(`/internal/news-jobs/${encodeURIComponent(job.request.jobId)}`, {
        workerId: job.workerId,
        version: job.version,
        status,
        checkpoint,
        error: error ?? null,
      }),
    );
  }
}
