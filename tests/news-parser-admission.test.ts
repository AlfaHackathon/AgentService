import type { Consumer, EachBatchPayload, KafkaMessage } from 'kafkajs';
import { expect, it, vi } from 'vitest';
import { NewsAnalyzer } from '../src/news-analysis/application/company-analysis.ts';
import { NewsFlow } from '../src/news-analysis/application/news-flow.ts';
import { CompanyClient } from '../src/news-analysis/retrieval/company-client.ts';
import { ContextClient } from '../src/news-analysis/retrieval/context-client.ts';
import { FlowContextClient, FlowJobClient } from '../src/news-analysis/retrieval/flow-clients.ts';
import { InsightClient } from '../src/news-analysis/retrieval/insight-client.ts';
import { ParserNewsClient } from '../src/news-analysis/transport/http/parser-news-client.ts';
import { NewsKafkaConsumer } from '../src/news-analysis/transport/kafka/consumer.ts';

const id = '0123456789abcdef01234567';
const dto = {
  source: 'Tass',
  externalId: 'publisher-123',
  title: 'Synthetic news',
  text: 'Synthetic saved lead',
  publishedAt: '2026-10-25T00:00:00Z',
};
const secret = 'synthetic-adapter-only';
const parserUrl = 'http://parser.test/news-parser-service';
const contextUrl = 'http://context.test/context-service';
const insightUrl = 'http://insight.test/insight-service';

function batch() {
  const message: KafkaMessage = {
    value: Buffer.from(JSON.stringify({ Source: 'Tass', Id: id })),
    key: null,
    offset: '17',
    timestamp: '0',
    attributes: 0,
    headers: {},
  };
  return {
    batch: {
      topic: 'news-parser.news',
      partition: 0,
      highWatermark: '99',
      messages: [message],
      isEmpty: () => false,
      firstOffset: () => message.offset,
      lastOffset: () => message.offset,
      offsetLag: () => '0',
      offsetLagLow: () => '0',
    },
    heartbeat: vi.fn(async () => {}),
    pause: vi.fn(() => () => {}),
    resolveOffset: vi.fn(),
    commitOffsetsIfNecessary: vi.fn(async () => {}),
    uncommittedOffsets: () => ({ topics: [] }),
    isRunning: () => true,
    isStale: () => false,
  } satisfies EachBatchPayload;
}

it('resolves reference -> exact Context admission -> durable job before ack; stable replay reuses the job and invokes no reasoning', async () => {
  const sequence: string[] = [];
  const saved = new Set<string>();
  const writes: Record<string, unknown>[] = [];
  let releaseJob: (() => void) | undefined;
  const model = vi.fn(async () => {
    throw new Error('Model calls are forbidden in this admission test');
  });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    expect(init?.headers).toHaveProperty('X-Internal-Secret', secret);
    if (url === `${parserUrl}/internal/news/${id}`) {
      sequence.push('parser.read');
      return Response.json(dto);
    }
    if (url === `${contextUrl}/internal/news/admit`) {
      sequence.push('context.admit');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ ...dto, textCompleteness: 'lead' });
      return Response.json({
        newsMaterialId: 'context-owned-material',
        newsVersionId: 'context-owned-version',
        asOf: dto.publishedAt,
        textCompleteness: 'lead',
      });
    }
    if (url === `${insightUrl}/internal/news-jobs`) {
      sequence.push('job.write');
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      writes.push(body);
      expect(body).toMatchObject({
        newsMaterialId: 'context-owned-material',
        newsVersionId: 'context-owned-version',
      });
      expect(JSON.stringify(body)).not.toContain(id);
      if (writes.length === 1)
        await new Promise<void>((resolve) => {
          releaseJob = resolve;
        });
      saved.add(String(body.jobId));
      sequence.push('job.saved');
      return Response.json({
        request: body,
        status: 'queued',
        version: 0,
        workerId: null,
        leaseUntil: null,
        checkpoint: {},
        error: null,
        updatedAt: dto.publishedAt,
      });
    }
    throw new Error('Unexpected request outside read/admission boundary');
  });
  const flow = new NewsFlow({
    context: new FlowContextClient(contextUrl, secret, fetcher),
    companies: new CompanyClient('http://company.test/company-service', secret, fetcher),
    jobs: new FlowJobClient(insightUrl, secret, fetcher),
    analyzer: new NewsAnalyzer({
      context: new ContextClient(contextUrl, secret, fetcher),
      insights: new InsightClient(insightUrl, secret, fetcher),
      reasoner: { analyze: model },
    }),
    reasoner: { plan: model, role: model },
  });
  // Admission must be tested without starting the process-level worker/pump.
  const worker = vi.spyOn(flow, 'start').mockImplementation(() => {});
  const port = {
    connect: vi.fn<Consumer['connect']>(async () => {}),
    subscribe: vi.fn<Consumer['subscribe']>(async () => {}),
    run: vi.fn<Consumer['run']>(async () => {}),
    stop: vi.fn<Consumer['stop']>(async () => {}),
    disconnect: vi.fn<Consumer['disconnect']>(async () => {}),
    commitOffsets: vi.fn<Consumer['commitOffsets']>(async () => {
      sequence.push('broker.ack');
    }),
  };
  const parser = new ParserNewsClient(parserUrl, secret, fetcher);
  const consumer = new NewsKafkaConsumer(
    port,
    flow,
    'news-parser.news',
    'synthetic-test',
    true,
    () => {},
    (ref) => parser.read(ref),
  );
  consumer.start();
  await vi.waitFor(() => expect(port.run).toHaveBeenCalledOnce());
  try {
    const payload = batch();
    const pending = consumer.eachBatch(payload);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(port.commitOffsets).not.toHaveBeenCalled();
    expect(payload.resolveOffset).not.toHaveBeenCalled();
    if (!releaseJob) throw new Error('Missing deferred durable save');
    releaseJob();
    await pending;
    expect(sequence).toEqual([
      'parser.read',
      'context.admit',
      'job.write',
      'job.saved',
      'broker.ack',
    ]);
    expect(port.commitOffsets).toHaveBeenCalledWith([
      { topic: 'news-parser.news', partition: 0, offset: '18' },
    ]);
    await consumer.eachBatch(batch());
    expect(saved.size).toBe(1);
    expect(writes[0]).toEqual(writes[1]);
    expect(worker).toHaveBeenCalledTimes(2);
    expect(model).not.toHaveBeenCalled();
  } finally {
    await consumer.stop();
    worker.mockRestore();
  }
});
