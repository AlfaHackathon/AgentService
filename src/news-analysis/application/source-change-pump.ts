import type { CompanyClient } from '../retrieval/company-client.ts';
import type { FlowContextClient, FlowJobClient } from '../retrieval/flow-clients.ts';
import type { NewsFlow } from './news-flow.ts';

export class SourceChangePump {
  private active = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly context: Pick<FlowContextClient, 'changes'>;
  private readonly companies: Pick<CompanyClient, 'changes'>;
  private readonly jobs: FlowJobClient;
  private readonly flow: Pick<NewsFlow, 'enqueue'>;
  constructor(
    context: Pick<FlowContextClient, 'changes'>,
    jobs: FlowJobClient,
    flow: Pick<NewsFlow, 'enqueue'>,
    companies: Pick<CompanyClient, 'changes'>,
  ) {
    this.context = context;
    this.companies = companies;
    this.jobs = jobs;
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
      const results = await Promise.allSettled([this.deliver('context'), this.deliver('company')]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } finally {
      this.active = false;
    }
  }
  private async deliver(source: 'context' | 'company') {
    const cursor = await this.jobs.sourceCursor(source);
    const event = (
      await (source === 'company' ? this.companies : this.context).changes(cursor.sequence)
    )[0];
    if (!event) return;
    const page = await this.jobs.sourceJobs(event, cursor.afterQuestion);
    for (const request of page.requests) await this.flow.enqueue(request);
    // Enqueue precedes cursor CAS: a crash replays identical job IDs, never loses work.
    await this.jobs.advanceSourceCursor(
      {
        ...cursor,
        sequence: page.nextCursor ? cursor.sequence : event.sequence,
        afterQuestion: page.nextCursor,
      },
      source,
    );
  }
}
