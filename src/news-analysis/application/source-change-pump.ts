import type { FlowContextClient, FlowJobClient } from '../retrieval/flow-clients.ts';
import type { NewsAnalyzer } from './company-analysis.ts';
import type { NewsFlow } from './news-flow.ts';

export class SourceChangePump {
  private active = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly context: FlowContextClient;
  private readonly jobs: FlowJobClient;
  private readonly analyzer: NewsAnalyzer;
  private readonly flow: NewsFlow;
  constructor(
    context: FlowContextClient,
    jobs: FlowJobClient,
    analyzer: NewsAnalyzer,
    flow: NewsFlow,
  ) {
    this.context = context;
    this.jobs = jobs;
    this.analyzer = analyzer;
    this.flow = flow;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 5000);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async tick() {
    if (this.active) return;
    this.active = true;
    try {
      const cursor = await this.jobs.sourceCursor();
      const event = (await this.context.changes(cursor.sequence))[0];
      if (!event) return;
      const supported = [
        'material:company',
        'material:market',
        'company',
        'group',
        'role',
      ].includes(event.category);
      if (!supported) {
        await this.jobs.advanceSourceCursor({
          ...cursor,
          sequence: event.sequence,
          afterQuestion: null,
        });
        return;
      }
      const page = await this.analyzer.react(event, cursor.afterQuestion);
      const anchors = new Map<
        string,
        { newsMaterialId: string; newsVersionId: string; companies: Set<string> }
      >();
      for (const work of page.items) {
        const key = JSON.stringify([work.newsMaterialId, work.newsVersionId]);
        const anchor = anchors.get(key) ?? {
          newsMaterialId: work.newsMaterialId,
          newsVersionId: work.newsVersionId,
          companies: new Set<string>(),
        };
        anchor.companies.add(work.companyId);
        anchors.set(key, anchor);
      }
      const groups = page.items.length
        ? (await this.context.groups(event.knownAt)).map((g) => g.groupId)
        : [];
      const groupBatches: string[][] = [];
      groups.sort();
      for (let offset = 0; offset < groups.length; offset += 32)
        groupBatches.push(groups.slice(offset, offset + 32));
      if (!groupBatches.length) groupBatches.push([]);
      for (const anchor of anchors.values())
        for (const groupIds of groupBatches)
          await this.flow.enqueue({
            newsMaterialId: anchor.newsMaterialId,
            newsVersionId: anchor.newsVersionId,
            asOf: event.knownAt,
            targetCompanyIds: [...anchor.companies].sort(),
            groupIds,
            companyBudget: 4,
            textCompleteness: 'unknown',
            projectionOnly: !event.category.startsWith('material:'),
            ...(event.category.startsWith('material:')
              ? { trigger: { materialId: event.entityId, versionId: event.versionId } }
              : {}),
          });
      // Enqueue precedes cursor CAS: a crash replays identical job IDs, never loses work.
      await this.jobs.advanceSourceCursor({
        ...cursor,
        sequence: page.nextCursor ? cursor.sequence : event.sequence,
        afterQuestion: page.nextCursor,
      });
    } finally {
      this.active = false;
    }
  }
}
