import type { Consumer, EachBatchPayload, KafkaMessage } from 'kafkajs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewsAnalysisError } from '../src/news-analysis/contracts/errors.ts';
import { flowRequestSchema, jobSchema } from '../src/news-analysis/contracts/flow.ts';
import { parseNewsKafkaEvent } from '../src/news-analysis/contracts/news-event.ts';
import { FlowContextClient, FlowJobClient } from '../src/news-analysis/retrieval/flow-clients.ts';
import {
  createNewsKafkaConsumer,
  NewsKafkaConsumer,
} from '../src/news-analysis/transport/kafka/consumer.ts';

const event = {
  Source: 'tass',
  ExternalId: '123',
  Title: 'Rate news',
  Text: '',
  PublishedAt: '2026-10-23T06:00:00Z',
};
const raw = Buffer.from(JSON.stringify(event));
const job = jobSchema.parse({
  request: {
    jobId: 'durable-job',
    newsMaterialId: 'n',
    newsVersionId: 'v',
    asOf: event.PublishedAt,
    parameters: {},
  },
  status: 'queued',
  version: 0,
  workerId: null,
  leaseUntil: null,
  checkpoint: {},
  error: null,
  updatedAt: event.PublishedAt,
});

function fixture() {
  const port = {
    connect: vi.fn<Consumer['connect']>(async () => {}),
    subscribe: vi.fn<Consumer['subscribe']>(async () => {}),
    run: vi.fn<Consumer['run']>(async () => {}),
    stop: vi.fn<Consumer['stop']>(async () => {}),
    disconnect: vi.fn<Consumer['disconnect']>(async () => {}),
    commitOffsets: vi.fn<Consumer['commitOffsets']>(async () => {}),
  };
  const flow = { ingest: vi.fn(async (_event: unknown) => job) };
  const log = vi.fn();
  const pump = new NewsKafkaConsumer(
    port,
    flow,
    'news-parser.news',
    'agent-service-news-v1',
    true,
    log,
  );
  return { port, flow, log, pump };
}
function batch(values = [raw], firstOffset = '0') {
  const messages: KafkaMessage[] = values.map((value, i) => ({
    value,
    key: null,
    offset: (BigInt(firstOffset) + BigInt(i)).toString(),
    timestamp: '0',
    attributes: 0,
    headers: {},
  }));
  return {
    batch: {
      topic: 'news-parser.news',
      partition: 0,
      highWatermark: '99',
      messages,
      isEmpty: () => !messages.length,
      firstOffset: () => messages[0]?.offset ?? null,
      lastOffset: () => messages.at(-1)?.offset ?? '0',
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
async function start(f: ReturnType<typeof fixture>) {
  f.pump.start();
  await vi.waitFor(() => expect(f.port.run).toHaveBeenCalledOnce());
  f.pump.joined();
}

afterEach(() => vi.useRealTimers());
describe('current NewsEventMessage Kafka boundary', () => {
  it('decodes Pascal/camel fields, preserves empty lead and does not fabricate source metadata', () => {
    expect(parseNewsKafkaEvent(raw)).toEqual({
      source: 'tass',
      externalId: '123',
      title: 'Rate news',
      text: '',
      publishedAt: event.PublishedAt,
      textCompleteness: 'lead',
    });
    expect(
      parseNewsKafkaEvent(
        Buffer.from(
          JSON.stringify({
            source: 'tass',
            externalId: '123',
            title: 'Rate news',
            text: '',
            publishedAt: event.PublishedAt,
          }),
        ),
      ),
    ).toEqual(parseNewsKafkaEvent(raw));
    for (const value of [
      null,
      Buffer.from('{'),
      Buffer.from([0xff]),
      Buffer.from(JSON.stringify({ ...event, CompanyId: 'injected' })),
      Buffer.alloc(1048577),
    ])
      expect(() => parseNewsKafkaEvent(value)).toThrow();
  });
  it('commits exact offset+1 only after durable admission, including duplicate deliveries', async () => {
    const f = fixture();
    await start(f);
    let release: ((value: typeof job) => void) | undefined;
    f.flow.ingest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const payload = batch([raw], '9007199254740993');
    const work = f.pump.eachBatch(payload);
    await vi.waitFor(() => expect(f.flow.ingest).toHaveBeenCalledOnce());
    expect(f.port.commitOffsets).not.toHaveBeenCalled();
    if (!release) throw new Error('Missing deferred admission');
    release(job);
    await work;
    expect(f.port.commitOffsets).toHaveBeenCalledWith([
      { topic: 'news-parser.news', partition: 0, offset: '9007199254740994' },
    ]);
    await f.pump.eachBatch(batch([raw], '9007199254740994'));
    expect(f.pump.status().lastAccepted?.jobId).toBe('durable-job');
    expect(f.port.run.mock.calls[0]?.[0]).toMatchObject({
      autoCommit: false,
      eachBatchAutoResolve: false,
    });
    await f.pump.stop();
  });
  it('leaves a failed admission uncommitted for retry', async () => {
    const f = fixture();
    await start(f);
    f.flow.ingest.mockRejectedValueOnce(
      new NewsAnalysisError(502, 'UPSTREAM_UNAVAILABLE', 'Unavailable'),
    );
    await expect(f.pump.eachBatch(batch())).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(f.port.commitOffsets).not.toHaveBeenCalled();
    await f.pump.eachBatch(batch());
    expect(f.port.commitOffsets).toHaveBeenCalledOnce();
    await f.pump.stop();
  });

  it('replays an admitted job when the broker acknowledgement fails', async () => {
    const f = fixture();
    await start(f);
    f.port.commitOffsets.mockRejectedValueOnce(new Error('Broker disconnected after admission'));
    const first = batch();
    await expect(f.pump.eachBatch(first)).rejects.toThrow('Broker disconnected');
    expect(first.resolveOffset).not.toHaveBeenCalled();
    await f.pump.eachBatch(batch());
    expect(f.flow.ingest).toHaveBeenCalledTimes(2);
    expect(f.pump.status().lastAccepted?.jobId).toBe('durable-job');
    await f.pump.stop();
  });
  it('retries malformed backend success responses without pausing a valid event', async () => {
    for (const boundary of ['material', 'saveMaterial', 'create'] as const) {
      const f = fixture();
      await start(f);
      const backend = vi.fn<typeof fetch>(async () =>
        Response.json({ invalidBackendResponse: true }),
      );
      const context = new FlowContextClient('http://context.test', 'test-secret', backend);
      const jobs = new FlowJobClient('http://insights.test', 'test-secret', backend);
      f.flow.ingest.mockImplementationOnce(async () => {
        if (boundary === 'material') await context.material('n', 'v');
        else if (boundary === 'saveMaterial') await context.saveMaterial({});
        else
          await jobs.create(
            job.request.jobId,
            flowRequestSchema.parse({
              newsMaterialId: 'n',
              newsVersionId: 'v',
              asOf: event.PublishedAt,
            }),
          );
        return job;
      });
      const payload = batch();
      await expect(f.pump.eachBatch(payload)).rejects.toMatchObject({
        status: 502,
        code: 'UPSTREAM_CONTRACT',
      });
      expect(payload.pause).not.toHaveBeenCalled();
      expect(f.port.commitOffsets).not.toHaveBeenCalled();
      await f.pump.eachBatch(batch());
      expect(f.port.commitOffsets).toHaveBeenCalledOnce();
      await f.pump.stop();
    }
  });
  it('does not commit a stale or interrupted batch after its job was saved', async () => {
    const f = fixture();
    await start(f);
    let stale = false;
    f.flow.ingest.mockImplementationOnce(async () => {
      stale = true;
      return job;
    });
    const payload = { ...batch(), isStale: () => stale };
    await f.pump.eachBatch(payload);
    expect(f.port.commitOffsets).not.toHaveBeenCalled();
    expect(payload.resolveOffset).not.toHaveBeenCalled();
    await f.pump.stop();
  });
  it('pauses a poison partition without acknowledging it or processing its later messages', async () => {
    const f = fixture();
    await start(f);
    const payload = batch([Buffer.from('invalid private payload'), raw]);
    await f.pump.eachBatch(payload);
    expect(payload.pause).toHaveBeenCalledOnce();
    expect(f.flow.ingest).not.toHaveBeenCalled();
    expect(f.port.commitOffsets).not.toHaveBeenCalled();
    expect(f.pump.status()).toMatchObject({
      status: 'blocked',
      blocked: [{ offset: '0', code: 'INVALID_EVENT' }],
    });
    expect(() => f.pump.ready()).toThrow();
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('private payload');
    await f.pump.stop();
  });
  it('keeps heartbeating while admission is awaiting its backend', async () => {
    const f = fixture();
    await start(f);
    vi.useFakeTimers();
    let release: ((value: typeof job) => void) | undefined;
    f.flow.ingest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const payload = batch();
    const work = f.pump.eachBatch(payload);
    await vi.advanceTimersByTimeAsync(7500);
    expect(payload.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
    if (!release) throw new Error('Missing deferred admission');
    release(job);
    await work;
    await f.pump.stop();
  });
  it('is optional and rejects an enabled but incomplete configuration', () => {
    const f = fixture();
    expect(createNewsKafkaConsumer(f.flow, {})).toBeUndefined();
    expect(() => createNewsKafkaConsumer(f.flow, { NEWS_KAFKA_ENABLED: 'true' })).toThrow(
      'configuration',
    );
    expect(() => createNewsKafkaConsumer(f.flow, { NEWS_KAFKA_ENABLED: 'typo' })).toThrow();
  });
});
