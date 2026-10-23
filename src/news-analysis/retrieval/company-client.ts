import { z } from 'zod';
import { type FlowRequest, groupExpansionSchema, segmentSchema } from '../contracts/flow.ts';
import { sourceChangeSchema } from '../contracts/source-changes.ts';
import { parseResponse, ServiceClient } from '../transport/http/service-client.ts';

export class CompanyClient {
  readonly http: ServiceClient;
  constructor(url: string, secret: string, fetcher = fetch) {
    this.http = new ServiceClient(url, secret, fetcher);
  }
  async select(request: FlowRequest, queries: string[], previousCompanyIds: string[]) {
    return parseResponse(
      z.object({
        groups: z.array(groupExpansionSchema),
        selectedCompanyIds: z.array(z.uuid()),
        pendingCompanyIds: z.array(z.uuid()),
      }),
      await this.http.request(
        '/internal/knowledge/selection',
        {
          asOf: request.asOf,
          targetCompanyIds: request.targetCompanyIds,
          groupIds: request.groupIds,
          personIds: request.personIds,
          queries,
          previousCompanyIds,
          companyBudget: request.companyBudget,
          projectionOnly: request.projectionOnly,
        },
        false,
        120000,
      ),
    );
  }
  async segments(asOf: string, companyIds: string[]) {
    return parseResponse(
      z.object({ segments: z.array(segmentSchema) }),
      await this.http.request('/internal/knowledge/segments', { asOf, companyIds }),
    ).segments;
  }
  async changes(after: number) {
    return parseResponse(
      z.object({ changes: z.array(sourceChangeSchema) }),
      await this.http.request(`/internal/knowledge/changes?after=${after}`),
    ).changes;
  }
}
