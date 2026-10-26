import { z } from 'zod';
import type { NewsAnalyzer } from '../news-analysis/application/company-analysis.ts';
import type {
  AnalysisReceipt,
  materialSchema,
  sourceRefSchema,
} from '../news-analysis/contracts/analysis.ts';
import { validateDeclaredProfile } from '../news-analysis/contracts/declared-profile.ts';
import { NewsAnalysisError } from '../news-analysis/contracts/errors.ts';
import { instantAfter, sameInstant } from '../news-analysis/contracts/timestamps.ts';
import type { AssistantServiceClients } from './service-clients.ts';

type SourceHandle = z.infer<typeof sourceRefSchema> & {
  handle: string;
  companyId: string;
  asOf: string;
};
export type AssistantToolState = {
  asOf: string;
  calls: number;
  analyses: number;
  outputCharacters: number;
  nextHandle: number;
  sources: SourceHandle[];
  // Optional for conversations persisted before news discovery was introduced.
  newsSources?: SourceHandle[];
};
export const initialAssistantState = (): AssistantToolState => ({
  asOf: new Date().toISOString(),
  calls: 0,
  analyses: 0,
  outputCharacters: 0,
  nextHandle: 0,
  sources: [],
  newsSources: [],
});
export type AssistantDependencies = {
  owner: (chatId: string) => Promise<string | null>;
  clients: AssistantServiceClients;
  analyzer: Pick<NewsAnalyzer, 'analyze'>;
};
export class AssistantToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AssistantToolError';
  }
}
const deny = (code: string, message: string): never => {
  throw new AssistantToolError(code, message);
};
const unavailable = {
  status: 'unavailable',
  code: 'SERVICE_UNAVAILABLE',
  message: 'Service data is unavailable. Preserve unknowns; do not invent a result.',
};

// Owns only conversational admission/budgets. Domain analysis remains in NewsAnalyzer
// and the Company/Context/Insight services.
export class AssistantToolSession {
  constructor(
    readonly chatId: string,
    readonly state: AssistantToolState,
    readonly dependencies: () => Promise<AssistantDependencies>,
    readonly persist: (state: AssistantToolState) => void,
  ) {}

  begin() {
    Object.assign(this.state, {
      asOf: new Date().toISOString(),
      calls: 0,
      analyses: 0,
      outputCharacters: 0,
    });
    this.persist(this.state);
  }

  async run(action: () => Promise<unknown>): Promise<{ output: string }> {
    if (this.state.calls >= 8 || this.state.outputCharacters >= 60000)
      return {
        output: JSON.stringify({
          status: 'unavailable',
          code: 'TOOL_BUDGET',
          message: 'Message service budget exhausted. Preserve remaining unknowns.',
        }),
      };
    this.state.calls++;
    try {
      const output = JSON.stringify(await action());
      if (output.length > 24000 || this.state.outputCharacters + output.length > 60000)
        return {
          output: JSON.stringify({
            status: 'unavailable',
            code: 'OUTPUT_BUDGET',
            message:
              'The complete result exceeds the context budget. Refine the query; no truncated original was supplied.',
          }),
        };
      this.state.outputCharacters += output.length;
      return { output };
    } catch (error) {
      // Never expose raw upstream errors (which may contain credentials or foreign data).
      const known = error instanceof AssistantToolError;
      return {
        output: JSON.stringify(
          known
            ? { status: 'unavailable', code: error.code, message: error.message }
            : {
                ...unavailable,
                code:
                  error instanceof NewsAnalysisError && error.code === 'UPSTREAM_TIMEOUT'
                    ? 'SERVICE_TIMEOUT'
                    : unavailable.code,
              },
        ),
      };
    } finally {
      this.persist(this.state);
    }
  }

  private async scope() {
    z.uuid().parse(this.chatId);
    const deps = await this.dependencies();
    const ownerId = await deps.owner(this.chatId);
    if (!ownerId || !z.uuid().safeParse(ownerId).success)
      return deny('ASSISTANT_NO_OWNER', 'No trusted chat owner is available.');
    const membership = await deps.clients.membership(ownerId);
    if (!membership)
      return deny('ASSISTANT_NO_COMPANY', 'The chat owner has no company membership.');
    return {
      ...deps,
      ownerId,
      membership,
      companyId: membership.id.toLowerCase(),
      asOf: this.state.asOf,
    };
  }

  private handle(ref: z.infer<typeof sourceRefSchema>, companyId: string, asOf: string) {
    const existingIndex = this.state.sources.findIndex(
      (s) =>
        s.companyId === companyId &&
        s.materialId === ref.materialId &&
        s.versionId === ref.versionId &&
        s.contentHash === ref.contentHash,
    );
    const existing = this.state.sources[existingIndex];
    if (existing) {
      this.state.sources.splice(existingIndex, 1);
      this.state.sources.push(existing);
      return existing.handle;
    }
    const handle = `s${this.state.nextHandle++}`;
    this.state.sources.push({ ...ref, companyId, asOf, handle });
    this.state.sources = this.state.sources.slice(-24);
    return handle;
  }

  private async original(
    scope: Awaited<ReturnType<AssistantToolSession['scope']>>,
    handle: string,
  ) {
    const ref = this.state.sources.find((source) => source.handle === handle);
    if (!ref || ref.companyId !== scope.companyId)
      return deny(
        'ASSISTANT_SOURCE_SCOPE',
        'Search the permitted context again for a valid source handle.',
      );
    const source = await scope.clients.material(ref.materialId, ref.versionId);
    if (
      source.materialId !== ref.materialId ||
      source.versionId !== ref.versionId ||
      source.contentHash !== ref.contentHash ||
      instantAfter(source.knownAt, ref.asOf) ||
      !(
        source.companyIds.some((id) => id.toLowerCase() === scope.companyId) ||
        (source.kind === 'market' && source.companyIds.length === 0)
      )
    )
      return deny(
        'ASSISTANT_SOURCE_SCOPE',
        'The original does not match the permitted source scope, hash or time.',
      );
    return source;
  }

  async profile() {
    const scope = await this.scope();
    const profile = await scope.clients.profile(scope.companyId, scope.asOf);
    if (
      profile.companyId.toLowerCase() !== scope.companyId ||
      instantAfter(profile.knownAt, scope.asOf)
    )
      return deny(
        'ASSISTANT_PROFILE_SCOPE',
        'The company profile does not match the trusted scope.',
      );
    const snapshots = await Promise.all(
      (profile.declaredProfile?.sourceRefs ?? []).map((ref) =>
        scope.clients.material(ref.materialId, ref.versionId),
      ),
    );
    validateDeclaredProfile(profile, snapshots, scope.companyId, scope.asOf);
    const viewer = await scope.clients.viewerContext(scope.ownerId.toLowerCase(), scope.companyId);
    return { asOf: scope.asOf, profile, viewer };
  }

  async search(query: string) {
    const scope = await this.scope();
    const result = await scope.clients.search(scope.companyId, query, scope.asOf);
    if (result.hits.some((hit) => hit.companyId.toLowerCase() !== scope.companyId))
      return deny('ASSISTANT_SEARCH_SCOPE', 'Search returned a different company scope.');
    let remaining = 24;
    let omittedSourceRefs = 0;
    const hits = result.hits.map((hit) => {
      const refs = [...hit.sourceRefs, ...(hit.relatedVersions ?? [])];
      const selected = refs.slice(0, remaining);
      remaining -= selected.length;
      omittedSourceRefs += refs.length - selected.length;
      return {
        excerpt: hit.excerpt,
        sources: selected.map((ref) => ({
          ...ref,
          sourceHandle: this.handle(ref, scope.companyId, scope.asOf),
        })),
      };
    });
    return {
      asOf: scope.asOf,
      exhaustive: result.exhaustive && omittedSourceRefs === 0,
      omittedSourceRefs,
      hits,
    };
  }

  async read(handle: string) {
    const source = await this.original(await this.scope(), handle);
    const { companyIds: _companies, bankProfileIds: _profiles, ...original } = source;
    return { sourceHandle: handle, original };
  }

  private selectedNews(scope: Awaited<ReturnType<AssistantToolSession['scope']>>, handle: string) {
    const ref = this.state.newsSources?.find((source) => source.handle === handle);
    if (!ref || ref.companyId !== scope.companyId)
      return deny('ASSISTANT_NEWS_HANDLE', 'Search permitted news again for a valid news handle.');
    return ref;
  }

  private validateNews(
    news: Omit<z.infer<typeof materialSchema>, 'text'>,
    asOf: string,
    expected?: z.infer<typeof sourceRefSchema>,
  ) {
    if (
      news.kind !== 'news' ||
      news.companyIds.length ||
      news.bankProfileIds.length ||
      instantAfter(news.knownAt, asOf) ||
      (expected &&
        (news.materialId !== expected.materialId ||
          news.versionId !== expected.versionId ||
          news.contentHash !== expected.contentHash))
    )
      return deny(
        'ASSISTANT_NEWS_SCOPE',
        'News does not match the permitted public version, hash or time.',
      );
  }

  async searchNews(query: string) {
    const scope = await this.scope();
    const result = await scope.clients.searchNews(query, scope.asOf);
    if (!result)
      return deny(
        'ASSISTANT_NEWS_SEARCH_UNAVAILABLE',
        'The admitted news catalog is not available. This is not an empty search result.',
      );
    if (!sameInstant(result.asOf, scope.asOf))
      return deny('ASSISTANT_NEWS_SCOPE', 'News search changed the server snapshot.');
    // Validate the entire response before admitting any handle or disclosing a title.
    for (const hit of result.hits) this.validateNews(hit, scope.asOf);
    const hits = result.hits.map((hit) => {
      const sources = this.state.newsSources ?? [];
      const index = sources.findIndex(
        (s) =>
          s.companyId === scope.companyId &&
          s.materialId === hit.materialId &&
          s.versionId === hit.versionId &&
          s.contentHash === hit.contentHash,
      );
      const existing = sources[index];
      if (existing) sources.splice(index, 1);
      const ref = existing ?? {
        materialId: hit.materialId,
        versionId: hit.versionId,
        contentHash: hit.contentHash,
        companyId: scope.companyId,
        asOf: scope.asOf,
        handle: `n${this.state.nextHandle++}`,
      };
      sources.push(ref);
      this.state.newsSources = sources.slice(-24);
      return {
        newsHandle: ref.handle,
        title: hit.title,
        knownAt: hit.knownAt,
        publishedAt: hit.publishedAt ?? null,
        provenance: hit.provenance ?? null,
        textCompleteness: hit.provenance?.textCompleteness ?? 'unknown',
      };
    });
    return {
      asOf: scope.asOf,
      exhaustive: false,
      hits,
      instruction:
        'Candidates from admitted news only. Read assistant_read_news before citing text; lead, excerpt or unknown does not establish a full publication. Search does not start analysis.',
    };
  }

  async readNews(handle: string) {
    const scope = await this.scope();
    const ref = this.selectedNews(scope, handle);
    const source = await scope.clients.news(ref.materialId, ref.versionId, ref.asOf);
    this.validateNews(source, ref.asOf, ref);
    const { companyIds: _companies, bankProfileIds: _profiles, ...original } = source;
    return {
      newsHandle: handle,
      asOf: ref.asOf,
      original,
      textCompleteness: source.provenance?.textCompleteness ?? 'unknown',
      instruction:
        'Stored original text is not necessarily the full publication. Preserve provenance and completeness. Analyze this selection only on an explicit user request using newsHandle.',
    };
  }

  async analyzeSelectedNews(handle: string, triggerSourceHandle?: string) {
    const ref = this.state.newsSources?.find((source) => source.handle === handle);
    if (!ref)
      return deny('ASSISTANT_NEWS_HANDLE', 'Search permitted news again for a valid news handle.');
    return this.analyze(ref.materialId, ref.versionId, triggerSourceHandle, handle);
  }

  async effects(newsMaterialId: string, offset = 0, limit = 8) {
    const scope = await this.scope();
    const result = await scope.clients.effects(scope.companyId, newsMaterialId, scope.asOf);
    if (
      result.effects.some(
        (effect) =>
          effect.companyId.toLowerCase() !== scope.companyId ||
          effect.newsMaterialId !== newsMaterialId ||
          instantAfter(effect.currentRevision.asOf, scope.asOf),
      )
    )
      return deny(
        'ASSISTANT_EFFECT_SCOPE',
        'Insight results do not match the trusted company, news or time.',
      );
    return {
      asOf: scope.asOf,
      total: result.effects.length,
      offset,
      hasMore: offset + limit < result.effects.length,
      nextOffset: offset + limit < result.effects.length ? offset + limit : null,
      effects: result.effects
        .slice(offset, offset + limit)
        .map(({ effectId, literalObjectRef, requiresReassessment, currentRevision }) => ({
          effectId,
          literalObjectRef,
          requiresReassessment,
          currentRevision,
        })),
      instruction:
        'These are saved company effects. Missing/partial results do not establish zero impact. Display company importance only from currentRevision.companyImportance score/rationale; missing or null is not assessed, never infer it from legacy importance or priority.',
    };
  }

  async analyze(
    newsMaterialId: string,
    newsVersionId: string,
    triggerSourceHandle?: string,
    newsHandle?: string,
  ) {
    const scope = await this.scope();
    const selected = newsHandle ? this.selectedNews(scope, newsHandle) : undefined;
    const news = await scope.clients.news(newsMaterialId, newsVersionId, scope.asOf);
    this.validateNews(news, selected?.asOf ?? scope.asOf, selected);
    if (
      news.materialId !== newsMaterialId ||
      news.versionId !== newsVersionId ||
      news.kind !== 'news' ||
      news.companyIds.length ||
      instantAfter(news.knownAt, scope.asOf)
    )
      return deny(
        'ASSISTANT_NEWS_SCOPE',
        'Only an existing public news version known at this time can be analyzed.',
      );
    const triggerSource = triggerSourceHandle
      ? await this.original(scope, triggerSourceHandle)
      : undefined;
    const trigger = triggerSource
      ? { materialId: triggerSource.materialId, versionId: triggerSource.versionId }
      : undefined;
    const summarize = (receipt: AnalysisReceipt, duplicate: boolean) => {
      if (
        receipt.companyId.toLowerCase() !== scope.companyId ||
        receipt.newsMaterialId !== newsMaterialId ||
        receipt.newsVersionId !== newsVersionId ||
        instantAfter(receipt.asOf, scope.asOf) ||
        (receipt.trigger?.materialId ?? null) !== (trigger?.materialId ?? null) ||
        (receipt.trigger?.versionId ?? null) !== (trigger?.versionId ?? null)
      )
        return deny(
          'ASSISTANT_RECEIPT_SCOPE',
          'The receipt does not match the requested company analysis.',
        );
      return {
        status: 'completed',
        analysisId: receipt.analysisId,
        duplicate,
        asOf: receipt.asOf,
        resultSemantics: receipt.resultSemantics,
        contextComplete: receipt.contextComplete ?? false,
        effectCount: receipt.effects.length,
        instruction:
          'Read assistant_news_insights for current saved effects. A duplicate reuses the saved receipt; it is not a fresh reassessment.',
      };
    };
    // A receipt's identity excludes asOf. Reuse it explicitly instead of provoking
    // a parameter conflict or pretending the same version was freshly reanalyzed.
    const existing = await scope.clients.receipt(
      scope.companyId,
      newsMaterialId,
      newsVersionId,
      trigger,
    );
    if (existing) return summarize(existing, true);
    if (this.state.analyses >= 1)
      return deny(
        'ASSISTANT_ANALYSIS_BUDGET',
        'Only one new company analysis may be started per user message.',
      );
    const current = await this.scope();
    if (
      current.companyId !== scope.companyId ||
      current.membership.bankProfileId !== scope.membership.bankProfileId
    )
      return deny(
        'ASSISTANT_MEMBERSHIP_CHANGED',
        'Company membership changed. Start a new request.',
      );
    this.state.analyses++;
    try {
      const result = await scope.analyzer.analyze({
        companyId: scope.companyId,
        ...(scope.membership.bankProfileId
          ? { bankProfileId: scope.membership.bankProfileId }
          : {}),
        newsMaterialId,
        newsVersionId,
        asOf: scope.asOf,
        ...(trigger ? { trigger } : {}),
      });
      return summarize(result, result.duplicate || !result.reasoningInvoked);
    } catch {
      // A failed response can follow a committed write. Check the existing receipt
      // once, never blindly retry analysis with an uncertain external outcome.
      try {
        const saved = await scope.clients.receipt(
          scope.companyId,
          newsMaterialId,
          newsVersionId,
          trigger,
        );
        if (saved) return summarize(saved, true);
      } catch {
        /* Outcome remains unknown; no automatic retry. */
      }
      return {
        status: 'unknown',
        code: 'ANALYSIS_OUTCOME_UNKNOWN',
        message:
          'Analysis did not return a confirmed receipt. Check saved company insights; do not automatically retry or claim success.',
      };
    }
  }
}
