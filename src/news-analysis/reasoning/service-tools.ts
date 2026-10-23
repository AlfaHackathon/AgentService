import { useDataWriter, usePersistentState, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { instantAfter } from '../contracts/timestamps.ts';
import { ContextClient } from '../retrieval/context-client.ts';
import { ExternalNewsClient } from '../retrieval/external-news.ts';
import { FlowContextClient } from '../retrieval/flow-clients.ts';
import { objectCatalog, type Source, sourceKey } from '../retrieval/source-catalog.ts';

import {
  admitCompanyBundle,
  initialToolState,
  type ToolScope,
  type ToolState,
} from '../retrieval/tool-evidence.ts';

const query = v.pipe(v.string(), v.minLength(1), v.maxLength(2000));
const refs = (sources: Source[]) =>
  sources.map(({ materialId, versionId, contentHash }) => ({ materialId, versionId, contentHash }));
// Only trusted initialData controls company/time/grants. The model gets typed,
// read-only operations; it never supplies URLs, credentials or company IDs.
export function useServiceTools(scope: ToolScope | undefined) {
  const empty: ToolState = {
    sources: [],
    objects: [],
    trace: [],
    calls: 0,
    searches: 0,
    stopped: true,
    queries: [],
    externalQueries: [],
    observations: [],
    externalStopped: true,
  };
  const [persisted, persist] = usePersistentState<ToolState>(
    'news-service-tools',
    scope ? initialToolState(scope) : empty,
  );
  const write = useDataWriter('evidence');
  const state = structuredClone(persisted);
  let queue: Promise<unknown> = Promise.resolve();
  const execute = <T>(action: () => Promise<T>) => {
    const next = queue.then(async () => {
      if (state.calls >= 4)
        return {
          output: 'Service tool budget exhausted; submit the result with remaining unknowns.',
        };
      state.calls++;
      const before = structuredClone(state);
      try {
        const output = JSON.stringify(await action());
        const maximum =
          scope?.kind === 'company' ? (scope.maxToolOutputCharacters ?? 160000) : 160000;
        if ((state.outputCharacters ?? 0) + output.length > maximum) {
          Object.assign(state, before);
          state.stopped = true;
          state.externalStopped = true;
          state.trace.push({
            round: state.searches,
            queries: [],
            retrievedSources: [],
            stopReason: 'context_budget',
          });
          if (state.context) state.context.coverage.complete = false;
          return {
            output: JSON.stringify({
              stopReason: 'context_budget',
              instruction:
                'The whole original/tool response does not fit the remaining context. Preserve unknown; do not infer absence.',
            }),
          };
        }
        state.outputCharacters = (state.outputCharacters ?? 0) + output.length;
        return { output };
      } catch {
        state.stopped = true;
        state.externalStopped = true;
        return {
          output: JSON.stringify({
            status: 'unavailable',
            stopReason: 'service_error',
            instruction: 'Preserve the missing fact as unknown; do not invent evidence.',
          }),
        };
      } finally {
        persist(state);
        write(state);
      }
    });
    queue = next;
    return next;
  };
  if (!scope || state.calls >= 4) return state;
  const asOf = scope.kind === 'company' ? scope.request.asOf : scope.asOf;
  if (state.sources.length)
    useTool({
      name: 'context_read_original',
      description:
        'Read an exact already permitted original by source handle. Scope, version and asOf are fixed by the host. Does not acquire external publications.',
      input: v.strictObject({ sourceHandle: v.picklist(state.sources.map((_, i) => `s${i}`)) }),
      run: ({ data }) =>
        execute(async () => {
          const expected = state.sources[Number(data.sourceHandle.slice(1))];
          if (!expected) throw new Error('Unknown source');
          const client = new FlowContextClient(
            process.env.CONTEXT_SERVICE_URL ?? '',
            process.env.INTERNAL_SECRET ?? '',
          );
          client.http.deadlineAt = scope.deadlineAt;
          const source = await client.material(expected.materialId, expected.versionId);
          if (sourceKey(source) !== sourceKey(expected) || instantAfter(source.knownAt, asOf))
            throw new Error('Unavailable version');
          return { sourceHandle: data.sourceHandle, source, asOf };
        }),
    });
  if (scope.kind === 'company' && !state.stopped && state.searches < 2)
    useTool({
      name: 'context_find_company_facts',
      description:
        'Search loaded permitted originals for a concrete missing fact of the fixed company. Maximum two searches; no new evidence ends search. Known materialId may request that exact original; never guess a contract ID.',
      input: v.strictObject({
        missingFact: query,
        query,
        scope: v.picklist(['company', 'market']),
        materialId: v.nullable(query),
      }),
      run: ({ data }) =>
        execute(async () => {
          if (state.stopped || state.searches >= 2 || state.queries.includes(data.query)) {
            state.stopped = true;
            return { stopReason: 'no_new_evidence' };
          }
          state.searches++;
          state.queries.push(data.query);
          const client = new ContextClient(
            process.env.CONTEXT_SERVICE_URL ?? '',
            process.env.INTERNAL_SECRET ?? '',
          );
          client.http.deadlineAt = scope.deadlineAt;
          const found = await client.followUp(
            scope.request,
            [data.query],
            data.scope,
            data.materialId ? [data.materialId] : [],
          );
          const admitted = admitCompanyBundle(scope, state, found);
          state.sources = admitted.sources;
          state.objects = objectCatalog(state.sources, scope.request.companyId, [], state.objects);
          state.context = {
            ...found,
            materials: state.sources.slice(1),
            coverage: {
              ...found.coverage,
              complete: admitted.stopReason !== 'context_budget' && found.coverage.complete,
            },
          };
          state.stopped = admitted.stopReason !== 'new_evidence' || state.searches >= 2;
          state.trace.push({
            round: state.searches,
            queries: [data.query],
            retrievedSources: refs(admitted.fresh),
            stopReason:
              state.searches >= 2 && admitted.stopReason === 'new_evidence'
                ? 'round_budget'
                : admitted.stopReason,
          });
          return {
            asOf,
            coverage: found.coverage,
            stopReason: admitted.stopReason,
            sourceCatalog: state.sources.map((source, i) => ({
              handle: `s${i}`,
              materialId: source.materialId,
              versionId: source.versionId,
              ...(admitted.fresh.some((s) => sourceKey(s) === sourceKey(source)) ? { source } : {}),
            })),
            objectCatalog: state.objects,
          };
        }),
    });
  if (scope.kind === 'planner' && !state.stopped && state.searches < 2)
    useTool({
      name: 'context_search_public_materials',
      description:
        'Search already loaded public market originals at the fixed asOf, then read exact versions. Does not fetch the internet.',
      input: v.strictObject({ query }),
      run: ({ data }) =>
        execute(async () => {
          if (state.stopped || state.searches >= 2 || state.queries.includes(data.query)) {
            state.stopped = true;
            return { stopReason: 'no_new_evidence' };
          }
          state.searches++;
          state.queries.push(data.query);
          const client = new FlowContextClient(
            process.env.CONTEXT_SERVICE_URL ?? '',
            process.env.INTERNAL_SECRET ?? '',
          );
          client.http.deadlineAt = scope.deadlineAt;
          const hits = await client.search(data.query, asOf, true);
          const known = new Set(state.sources.map(sourceKey));
          const fresh: Source[] = [];
          for (const ref of hits.hits
            .flatMap((h) => [...(h.relatedVersions ?? []), ...h.sourceRefs])
            .slice(0, 6)) {
            client.http.deadlineAt = scope.deadlineAt;
            const source = await client.material(ref.materialId, ref.versionId);
            if (
              sourceKey(ref) !== sourceKey(source) ||
              source.kind !== 'market' ||
              source.companyIds.length ||
              instantAfter(source.knownAt, asOf)
            )
              throw new Error('Public scope mismatch');
            if (!known.has(sourceKey(source))) {
              known.add(sourceKey(source));
              fresh.push(source);
            }
          }
          const budget = JSON.stringify([...state.sources, ...fresh]).length > 120000;
          if (!budget) state.sources.push(...fresh);
          state.stopped = budget || !fresh.length || state.searches >= 2;
          const stopReason = budget
            ? 'context_budget'
            : fresh.length
              ? 'new_evidence'
              : 'no_new_evidence';
          state.trace.push({
            round: state.searches,
            queries: [data.query],
            retrievedSources: budget ? [] : refs(fresh),
            stopReason,
          });
          return {
            asOf,
            stopReason,
            sources: budget ? [] : fresh,
            coverage: { exhaustive: hits.exhaustive },
          };
        }),
    });
  if (scope.kind === 'planner' && !state.externalStopped && state.externalQueries.length < 2)
    useTool({
      name: 'news_search_external_publications',
      description:
        'Call the existing news-service stored search or TASS proxy. Returns lead observations and exact URL when provided. No full-text/version/Alfa research API exists yet; candidates cannot be cited as loaded originals. Never send company names, banking context or private identifiers to external search.',
      input: v.strictObject({ query, channel: v.picklist(['stored', 'tass']) }),
      run: ({ data }) =>
        execute(async () => {
          if (state.externalStopped || state.externalQueries.includes(data.query)) {
            state.externalStopped = true;
            return { status: 'stopped', stopReason: 'no_new_evidence' };
          }
          state.externalQueries.push(data.query);
          if (!process.env.NEWS_SERVICE_URL) {
            state.externalStopped = true;
            return {
              status: 'unavailable',
              stopReason: 'news_service_not_configured',
              capabilities: { fullText: false, publisherVersions: false },
            };
          }
          const external = new ExternalNewsClient(
            process.env.NEWS_SERVICE_URL,
            process.env.INTERNAL_SECRET ?? '',
          );
          external.http.deadlineAt = scope.deadlineAt;
          const result = await external.search(data.query, data.channel, asOf);
          const fresh = result.items.filter((i) => !state.observations.includes(i.observationHash));
          state.observations.push(...fresh.map((i) => i.observationHash));
          state.externalStopped = !fresh.length || state.externalQueries.length >= 2;
          return {
            ...result,
            items: fresh,
            stopReason: !fresh.length
              ? 'no_new_evidence'
              : state.externalQueries.length >= 2
                ? 'round_budget'
                : 'new_observations',
          };
        }),
    });
  return state;
}
