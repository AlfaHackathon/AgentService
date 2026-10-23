import { describe, expect, it, vi } from 'vitest';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import { NewsFlow } from '../src/news-analysis/application/news-flow.ts';
import { SourceChangePump } from '../src/news-analysis/application/source-change-pump.ts';
import { flowRequestSchema } from '../src/news-analysis/contracts/flow.ts';
import type { SourceChange } from '../src/news-analysis/contracts/source-changes.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { FlowContextClient, FlowJobClient } from '../src/news-analysis/retrieval/flow-clients.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
function fixture(category = 'material:company') {
  const context = new FlowContextClient('http://context.test', 'test'),
    jobs = new FlowJobClient('http://insights.test', 'test');
  const analyzer = new NewsAnalyzer({
    context: new ContextClient('http://context.test', 'test'),
    insights: new InsightClient('http://insights.test', 'test'),
    reasoner: { analyze: async () => [] },
  });
  const flow = new NewsFlow({
    context,
    jobs,
    analyzer,
    reasoner: {
      plan: async () => ({ eventSummary: 'Fixture', queries: ['fixture'], generalInsights: [] }),
      role: async () => ({ actions: [], missingContext: [] }),
    },
  });
  let cursor = { version: 0, sequence: 0, afterQuestion: null as string | null };
  const event: SourceChange = {
    sequence: 1,
    category,
    entityId: 'synthetic-contract',
    versionId: '2',
    knownAt: '2026-10-22T10:00:00Z',
    companyIds: [companyId],
  };
  vi.spyOn(jobs, 'sourceCursor').mockImplementation(async () => ({ ...cursor }));
  const advance = vi.spyOn(jobs, 'advanceSourceCursor').mockImplementation(async (input) => {
    cursor = { ...input, version: cursor.version + 1 };
    return cursor;
  });
  vi.spyOn(context, 'changes').mockImplementation(async (after) => (after < 1 ? [event] : []));
  vi.spyOn(context, 'groups').mockResolvedValue([{ groupId: 'root' }]);
  const work = {
    effectId: 'question-1',
    companyId,
    bankProfileId: null,
    newsMaterialId: 'news-a',
    newsVersionId: '1',
  };
  const react = vi
    .spyOn(analyzer, 'react')
    .mockResolvedValue({ items: [work, { ...work, effectId: 'question-2' }], nextCursor: null });
  const enqueue = vi.spyOn(flow, 'enqueue').mockResolvedValue({
    request: {
      jobId: 'fixture',
      newsMaterialId: 'news-a',
      newsVersionId: '1',
      asOf: event.knownAt,
      parameters: {},
    },
    status: 'queued',
    version: 0,
    workerId: null,
    leaseUntil: null,
    checkpoint: {},
    error: null,
    updatedAt: event.knownAt,
  });
  const pump = () => new SourceChangePump(context, jobs, analyzer, flow);
  return { pump, enqueue, advance, react, context, cursor: () => cursor, work };
}
describe('durable canonical source change delivery', () => {
  it('batches more than 32 groups without blocking or truncating the source cursor', async () => {
    const f = fixture();
    vi.mocked(f.context.groups).mockResolvedValue(
      Array.from({ length: 33 }, (_, i) => ({ groupId: `group-${i}` })),
    );
    await f.pump().tick();
    expect(f.enqueue).toHaveBeenCalledTimes(2);
    const groups = f.enqueue.mock.calls.flatMap((c) => flowRequestSchema.parse(c[0]).groupIds);
    expect(new Set(groups).size).toBe(33);
    expect(f.cursor().sequence).toBe(1);
  });
  it('deduplicates questions by company/news and advances only after durable enqueue', async () => {
    const f = fixture();
    await f.pump().tick();
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        targetCompanyIds: [companyId],
        trigger: { materialId: 'synthetic-contract', versionId: '2' },
        projectionOnly: false,
      }),
    );
    expect(f.advance.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.enqueue.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.cursor().sequence).toBe(1);
  });
  it('replays an enqueue after cursor failure and retains the original trigger after restart', async () => {
    const f = fixture();
    f.advance.mockRejectedValueOnce(new Error('Synthetic crash before cursor commit'));
    await expect(f.pump().tick()).rejects.toThrow('Synthetic crash');
    expect(f.cursor().sequence).toBe(0);
    await f.pump().tick();
    expect(f.enqueue.mock.calls[0]).toEqual(f.enqueue.mock.calls[1]);
    expect(f.cursor().sequence).toBe(1);
  });
  it('continues dependency pages and routes membership changes to projection refresh', async () => {
    const f = fixture('group');
    f.react.mockResolvedValueOnce({ items: [f.work], nextCursor: 'question-64' });
    await f.pump().tick();
    expect(f.cursor()).toMatchObject({ sequence: 0, afterQuestion: 'question-64' });
    await f.pump().tick();
    expect(f.react.mock.calls[1]?.[1]).toBe('question-64');
    expect(f.enqueue.mock.calls[0]?.[0]).toMatchObject({
      projectionOnly: true,
      groupIds: ['root'],
    });
    expect(f.enqueue.mock.calls[0]?.[0]).not.toHaveProperty('trigger');
    expect(f.cursor().sequence).toBe(1);
  });
});
