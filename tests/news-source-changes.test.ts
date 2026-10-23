import { describe, expect, it, vi } from 'vitest';
import { SourceChangePump } from '../src/news-analysis/application/source-change-pump.ts';
import { flowRequestSchema, jobSchema } from '../src/news-analysis/contracts/flow.ts';
import { FlowJobClient } from '../src/news-analysis/retrieval/flow-clients.ts';

const time = '2026-10-22T10:00:00Z';
function fixture(source: 'context' | 'company' = 'context') {
  const event = {
    sequence: 1,
    category: 'group',
    entityId: 'group',
    versionId: '2',
    knownAt: time,
    companyIds: [],
  };
  const request = flowRequestSchema.parse({
    newsMaterialId: 'news',
    newsVersionId: '1',
    asOf: time,
    projectionOnly: true,
  });
  let cursor = { version: 0, sequence: 0, afterQuestion: null as string | null };
  const jobs = new FlowJobClient('http://insights.test', 'secret');
  vi.spyOn(jobs, 'sourceCursor').mockImplementation(async (name) =>
    name === source ? { ...cursor } : { version: 0, sequence: 0, afterQuestion: null },
  );
  const advance = vi.spyOn(jobs, 'advanceSourceCursor').mockImplementation(async (input) => {
    cursor = { ...input, version: cursor.version + 1 };
    return cursor;
  });
  const sourceJobs = vi
    .spyOn(jobs, 'sourceJobs')
    .mockResolvedValue({ requests: [request], nextCursor: null });
  const changes = vi.fn(async (after: number) => (after < 1 ? [event] : []));
  const empty = vi.fn(async () => []);
  const enqueue = vi.fn(async () =>
    jobSchema.parse({
      request: { ...request, jobId: 'followup', parameters: request },
      status: 'queued',
      version: 0,
      workerId: null,
      leaseUntil: null,
      checkpoint: {},
      error: null,
      updatedAt: time,
    }),
  );
  const pump = () =>
    new SourceChangePump(
      { changes: source === 'context' ? changes : empty },
      jobs,
      { enqueue },
      { changes: source === 'company' ? changes : empty },
    );
  return { pump, enqueue, advance, sourceJobs, event, request, cursor: () => cursor };
}
describe('durable source delivery of backend-selected jobs', () => {
  it('uses an independent Company cursor and enqueues only backend proposals', async () => {
    const f = fixture('company');
    await f.pump().tick();
    expect(f.enqueue).toHaveBeenCalledWith(f.request);
    expect(f.advance).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }), 'company');
    expect(f.advance.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.enqueue.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it('replays enqueue after cursor commit failure', async () => {
    const f = fixture();
    f.advance.mockRejectedValueOnce(new Error('crash'));
    await expect(f.pump().tick()).rejects.toThrow('crash');
    expect(f.cursor().sequence).toBe(0);
    await f.pump().tick();
    expect(f.enqueue.mock.calls[0]).toEqual(f.enqueue.mock.calls[1]);
    expect(f.cursor().sequence).toBe(1);
  });
  it('retains the event sequence while continuing the backend page', async () => {
    const f = fixture();
    f.sourceJobs.mockResolvedValueOnce({ requests: [f.request], nextCursor: 'next' });
    await f.pump().tick();
    expect(f.cursor()).toMatchObject({ sequence: 0, afterQuestion: 'next' });
    await f.pump().tick();
    expect(f.sourceJobs.mock.calls[1]).toEqual([f.event, 'next']);
    expect(f.cursor().sequence).toBe(1);
  });
});
