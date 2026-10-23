import type { AnalysisRequest, ContextBundle } from '../contracts/analysis.ts';
import { instantAfter, sameInstant } from '../contracts/timestamps.ts';
import { type ObjectBinding, objectCatalog, type Source, sourceKey } from './source-catalog.ts';
export type ToolScope = (
  | {
      kind: 'company';
      request: AnalysisRequest;
      context: ContextBundle;
      objects: ObjectBinding[];
      maxSourceCharacters?: number;
      maxEvidenceCharacters?: number;
      maxToolOutputCharacters?: number;
    }
  | { kind: 'planner'; asOf: string; sources: Source[] }
  | { kind: 'role'; asOf: string; sources: Source[] }
) & { deadlineAt?: number };
export type ToolEvidence = {
  sources: Source[];
  objects: ObjectBinding[];
  context?: ContextBundle;
  trace: {
    round: number;
    queries: string[];
    retrievedSources: Pick<Source, 'materialId' | 'versionId' | 'contentHash'>[];
    stopReason: string;
  }[];
};
export type ToolState = ToolEvidence & {
  outputCharacters?: number;
  calls: number;
  searches: number;
  stopped: boolean;
  queries: string[];
  externalQueries: string[];
  observations: string[];
  externalStopped: boolean;
};

export function initialToolState(scope: ToolScope): ToolState {
  return {
    sources:
      scope.kind === 'company' ? [scope.context.news, ...scope.context.materials] : scope.sources,
    objects: scope.kind === 'company' ? scope.objects : [],
    ...(scope.kind === 'company' ? { context: scope.context } : {}),
    trace: [],
    calls: 0,
    searches: 0,
    stopped: false,
    queries: [],
    externalQueries: [],
    observations: [],
    externalStopped: false,
  };
}

export function admitCompanyBundle(
  scope: Extract<ToolScope, { kind: 'company' }>,
  state: ToolState,
  found: ContextBundle,
) {
  if (
    sourceKey(found.news) !== sourceKey(scope.context.news) ||
    !sameInstant(found.coverage.asOf, scope.request.asOf) ||
    [found.news, ...found.materials].some(
      (s) =>
        instantAfter(s.knownAt, scope.request.asOf) ||
        (s.companyIds.length && !s.companyIds.includes(scope.request.companyId)) ||
        (s.kind === 'company' && !s.companyIds.includes(scope.request.companyId)),
    )
  )
    throw new Error('Context service returned evidence outside the fixed company/time scope');
  const known = new Set(state.sources.map(sourceKey));
  const fresh = found.materials.filter((s) => !known.has(sourceKey(s)));
  const sources = [...state.sources, ...fresh];
  if (
    JSON.stringify(sources).length > (scope.maxSourceCharacters ?? 120000) ||
    JSON.stringify({
      sources,
      objects: objectCatalog(sources, scope.request.companyId, [], state.objects),
    }).length > (scope.maxEvidenceCharacters ?? 160000)
  )
    return { stopReason: 'context_budget', sources: state.sources, fresh: [] };
  return { sources, fresh, stopReason: fresh.length ? 'new_evidence' : 'no_new_evidence' };
}
