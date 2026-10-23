import { z } from 'zod';
import { analysisReceiptSchema, sourceRefSchema } from '../contracts/analysis.ts';
import { type CompanyRun, companyRunSchema, type GroupExpansion } from '../contracts/flow.ts';
import { parseResponse, ServiceClient } from '../transport/http/service-client.ts';

const revisionSchema = analysisReceiptSchema.shape.effects.element.shape.currentRevision;
const factSchema = z.object({
  companyId: z.uuid(),
  effectId: z.string(),
  revision: revisionSchema,
  priority: z.number(),
  requiresReassessment: z.boolean(),
});
const groupSchema = z.object({
  groupId: z.string(),
  companyIds: z.array(z.uuid()),
  complete: z.boolean(),
  coverage: z.object({
    expectedCompanies: z.number(),
    analyzedCompanies: z.number(),
    missingCompanyIds: z.array(z.uuid()),
    missingGroups: z.array(z.string()),
    cycles: z.array(z.array(z.string())),
    unknownEffects: z.array(z.string()),
    duplicateObjects: z.array(z.string()),
    unrevisedEffectIds: z.array(z.string()),
    emptyCompanyIds: z.array(z.uuid()),
    partialContextCompanyIds: z.array(z.uuid()),
    aggregationRuleConfirmed: z.boolean(),
  }),
  totals: z.array(
    z.object({
      metric: z.string(),
      amountBasis: z.string(),
      unit: z.string(),
      period: z.string(),
      question: revisionSchema.shape.question.unwrap().unwrap().nullable(),
      knownSubtotal: z.string(),
      fullTotal: z.string().nullable(),
      coverage: z.object({
        complete: z.boolean(),
        missingCompanyIds: z.array(z.uuid()),
        unresolvedEffectIds: z.array(z.string()),
        duplicateObjects: z.array(z.string()),
      }),
      effectIds: z.array(z.string()),
      companyIds: z.array(z.uuid()),
    }),
  ),
  sourceRefs: z.array(sourceRefSchema),
});
const canonicalRunSchema = companyRunSchema.extend({
  receipt: analysisReceiptSchema
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
  error: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
  contextComplete: z
    .boolean()
    .nullable()
    .optional()
    .transform((value) => value ?? false),
  staleEffectIds: z
    .array(z.string())
    .nullable()
    .optional()
    .transform((value) => value ?? []),
});

// The owning service reloads receipts and group membership. Send identities,
// rather than duplicate the evidence and histories in every projection request.
function companyReferences(companies: CompanyRun[]) {
  return companies.map(({ companyId, status, receipt }) => ({
    companyId,
    status,
    ...(receipt
      ? {
          receipt: {
            ...receipt,
            effects: [],
            retrievalTrace: [],
            unrevisedEffectIds: [],
          },
        }
      : {}),
  }));
}

function groupReferences(groups: GroupExpansion[]) {
  return groups.map(({ groupId }) => ({
    groupId,
    companyIds: [],
    paths: [],
    sourceRefs: [],
    missingGroups: [],
    cycles: [],
    complete: false,
  }));
}

export class InsightDomainClient {
  readonly http: ServiceClient;
  constructor(url: string, secret: string, fetcher = fetch) {
    this.http = new ServiceClient(url, secret, fetcher);
  }
  async canonicalFacts(companies: CompanyRun[], asOf: string) {
    return parseResponse(
      z.object({ companies: z.array(canonicalRunSchema), facts: z.array(factSchema) }),
      await this.http.request('/internal/projections/canonical-facts', {
        companies: companyReferences(companies),
        asOf,
      }),
    );
  }
  async groups(groups: GroupExpansion[], companies: CompanyRun[], asOf: string) {
    return parseResponse(
      z.object({ groups: z.array(groupSchema) }),
      await this.http.request('/internal/projections/groups', {
        groups: groupReferences(groups),
        companies: companyReferences(companies),
        asOf,
      }),
    ).groups;
  }
  async role(input: {
    personId: string;
    companyId: string;
    asOf: string;
    groups: GroupExpansion[];
    companies: CompanyRun[];
  }) {
    return parseResponse(
      z.object({
        profile: z.object({
          personId: z.string(),
          companyId: z.uuid(),
          role: z.string(),
          responsibilities: z.array(z.string()),
        }),
        facts: z.array(factSchema),
        groups: z.array(groupSchema),
      }),
      await this.http.request('/internal/projections/role', {
        ...input,
        groups: groupReferences(input.groups),
        companies: companyReferences(input.companies),
      }),
    );
  }
}
