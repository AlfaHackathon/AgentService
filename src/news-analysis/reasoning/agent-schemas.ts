import * as v from 'valibot';
import { mechanisms, periodPattern } from '../contracts/questions.ts';

const text = (maximum: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(maximum));
const score = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5));
const evidenceId = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_-]{0,63}$/));
const sourceRef = v.strictObject({
  materialId: text(200),
  versionId: text(200),
  contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
const conditions = v.pipe(v.array(v.pipe(v.string(), v.maxLength(1000))), v.maxLength(16));

export const planResultSchema = v.strictObject({
  mechanisms: v.optional(v.pipe(v.array(v.picklist(mechanisms)), v.minLength(1), v.maxLength(12))),
  segmentCoverage: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          segmentKey: text(200),
          insightIndexes: v.pipe(
            v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(7))),
            v.maxLength(8),
          ),
          reason: text(2000),
        }),
      ),
      v.maxLength(8),
    ),
  ),
  eventSummary: text(4000),
  queries: v.pipe(v.array(text(2000)), v.minLength(1), v.maxLength(6)),
  generalInsights: v.pipe(
    v.array(
      v.strictObject({
        title: text(500),
        conclusion: text(6000),
        mechanism: text(4000),
        applicability: conditions,
        exclusions: conditions,
        unknowns: conditions,
        sourceRefs: v.pipe(v.array(sourceRef), v.minLength(1), v.maxLength(32)),
      }),
    ),
    v.maxLength(8),
  ),
});

export function segmentResultSchema(unitIds: string[], segmentKeys: string[]) {
  const { sourceRefs: _refs, ...insightFields } =
    planResultSchema.entries.generalInsights.item.entries;
  return v.strictObject({
    sourceCoverage: v.pipe(
      v.array(
        v.strictObject({
          unitId: v.picklist(unitIds),
          signals: v.pipe(v.array(text(600)), v.maxLength(12)),
          disposition: v.picklist(['used', 'background', 'not_applicable', 'unreadable']),
          reason: text(1500),
        }),
      ),
      v.maxLength(64),
    ),
    eventSummary: planResultSchema.entries.eventSummary,
    generalInsights: v.pipe(
      v.array(
        v.strictObject({
          ...insightFields,
          sourceUnitIds: v.pipe(v.array(v.picklist(unitIds)), v.minLength(1), v.maxLength(64)),
          segmentKeys: v.pipe(v.array(v.picklist(segmentKeys)), v.minLength(1), v.maxLength(8)),
        }),
      ),
      v.maxLength(24),
    ),
    segmentCoverage: v.pipe(
      v.array(v.strictObject({ segmentKey: v.picklist(segmentKeys), reason: text(2000) })),
      v.maxLength(8),
    ),
    queries: v.pipe(v.array(text(2000)), v.maxLength(6)),
    mechanisms: planResultSchema.entries.mechanisms,
  });
}

export const roleResultSchema = v.strictObject({
  actions: v.pipe(
    v.array(
      v.strictObject({
        action: text(2000),
        rationale: text(2000),
        effectIds: v.pipe(
          v.array(v.pipe(v.string(), v.minLength(1))),
          v.minLength(1),
          v.maxLength(32),
        ),
        priority: score,
      }),
    ),
    v.maxLength(12),
  ),
  missingContext: v.pipe(v.array(text(1000)), v.maxLength(16)),
});

export function companyResultSchema(
  objectHandles: string[],
  sourceHandles: string[],
  questionHandles: string[] = [],
) {
  const identity = v.strictObject({
    mechanism: v.picklist(mechanisms),
    frame: v.picklist(['event_only', 'absolute', 'budget_delta']),
    unit: text(64),
    targetPeriod: v.pipe(v.string(), v.regex(periodPattern)),
    baselinePeriod: v.nullable(v.pipe(v.string(), v.regex(periodPattern))),
    basis: v.picklist([
      'qualitative',
      'monthly_run_rate',
      'annual_run_rate',
      'contract_total',
      'actual_cashflow',
      'budget_total',
      'unknown',
    ]),
  });
  return v.strictObject({
    drafts: v.pipe(
      v.array(
        v.strictObject({
          objectHandle: v.picklist(objectHandles),
          assessment: v.strictObject({
            applicability: v.optional(
              v.strictObject({
                status: v.picklist(['established', 'unknown', 'excluded']),
                basis: v.picklist([
                  'documented_exposure',
                  'profile_signal',
                  'market_only',
                  'not_established',
                ]),
                explanation: text(2000),
                sourceHandles: v.pipe(v.array(v.picklist(sourceHandles)), v.maxLength(16)),
                assumptions: v.pipe(v.array(text(1000)), v.maxLength(8)),
              }),
            ),
            conditions: v.pipe(
              v.array(
                v.strictObject({
                  id: evidenceId,
                  assertion: v.picklist(['observed', 'derived', 'conditional']),
                  dependsOn: v.pipe(v.array(evidenceId), v.maxLength(16)),
                  fact: text(1000),
                  predicate: text(1000),
                  status: v.picklist(['supported', 'contradicted', 'unknown']),
                  sourceHandles: v.pipe(v.array(v.picklist(sourceHandles)), v.maxLength(64)),
                }),
              ),
              v.maxLength(16),
            ),
            unknowns: v.pipe(
              v.array(
                v.strictObject({
                  id: evidenceId,
                  fact: text(1000),
                  query: v.nullable(text(2000)),
                  scope: v.picklist(['company', 'market']),
                  materialId: v.nullable(text(200)),
                }),
              ),
              v.maxLength(16),
            ),
          }),
          question: questionHandles.length
            ? v.union([v.picklist(questionHandles), identity])
            : identity,
          conclusion: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(12000)),
          status: v.picklist([
            'observed',
            'announced',
            'forecast',
            'conditional',
            'unknown',
            'unaffected',
            'contradicted',
          ]),
          impact: v.strictObject({
            metric: v.picklist([
              'expense_delta',
              'revenue_delta',
              'cashflow_delta',
              'absolute_expense',
              'risk',
              'opportunity',
              'other',
            ]),
            amountBasis: v.picklist([
              'standard_month_run_rate',
              'annual_run_rate',
              'contract_total',
              'actual_cashflow',
              'qualitative',
              'unknown',
            ]),
            economicObjectId: v.nullable(text(500)),
            evidenceStatus: v.picklist([
              'supported',
              'conditional',
              'unknown',
              'contradicted',
              'unaffected',
            ]),
            importance: score,
            urgency: score,
            novelty: score,
          }),
          sourceHandles: v.pipe(
            v.array(v.picklist(sourceHandles)),
            v.minLength(1),
            v.maxLength(64),
          ),
          calculation: v.optional(
            v.strictObject({
              expression: text(2000),
              unit: text(64),
              period: text(1000),
            }),
          ),
        }),
      ),
      v.maxLength(32),
    ),
  });
}
