import type { Consumer, EachBatchPayload, KafkaMessage } from 'kafkajs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewsAnalysisError } from '../src/news-analysis/contracts/errors.ts';
import { flowRequestSchema, jobSchema } from '../src/news-analysis/contracts/flow.ts';
import {
  parseNewsKafkaEvent,
  type ResolveParserNews,
} from '../src/news-analysis/contracts/news-event.ts';
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

function fixture(resolveParserNews?: ResolveParserNews) {
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
    resolveParserNews,
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
    for (const boundary of ['admitNews', 'create'] as const) {
      const f = fixture();
      await start(f);
      const backend = vi.fn<typeof fetch>(async () =>
        Response.json({ invalidBackendResponse: true }),
      );
      const context = new FlowContextClient('http://context.test', 'test-secret', backend);
      const jobs = new FlowJobClient('http://insights.test', 'test-secret', backend);
      f.flow.ingest.mockImplementationOnce(async () => {
        if (boundary === 'admitNews') await context.admitNews({});
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
  it('resolves parser ID under heartbeats, then waits for durable admission before acknowledging', async () => {
    const id = '0123456789abcdef01234567';
    let releaseRead: ((value: Awaited<ReturnType<ResolveParserNews>>) => void) | undefined;
    const resolve = vi.fn<ResolveParserNews>(
      () =>
        new Promise((done) => {
          releaseRead = done;
        }),
    );
    const f = fixture(resolve);
    await start(f);
    vi.useFakeTimers();
    let releaseSave: ((value: typeof job) => void) | undefined;
    f.flow.ingest.mockImplementationOnce(
      () =>
        new Promise((done) => {
          releaseSave = done;
        }),
    );
    const payload = batch([Buffer.from(JSON.stringify({ Source: 'Tass', Id: id }))]);
    const work = f.pump.eachBatch(payload);
    await vi.advanceTimersByTimeAsync(5000);
    expect(resolve).toHaveBeenCalledWith({ source: 'Tass', parserNewsId: id });
    expect(payload.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.flow.ingest).not.toHaveBeenCalled();
    expect(f.port.commitOffsets).not.toHaveBeenCalled();
    if (!releaseRead) throw new Error('Missing deferred read');
    releaseRead({
      source: 'Tass',
      externalId: 'publisher',
      title: 'Synthetic',
      text: '',
      publishedAt: event.PublishedAt,
      textCompleteness: 'lead',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.flow.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: 'publisher', textCompleteness: 'lead' }),
    );
    expect(f.port.commitOffsets).not.toHaveBeenCalled();
    if (!releaseSave) throw new Error('Missing deferred save');
    releaseSave(job);
    await work;
    expect(f.port.commitOffsets).toHaveBeenCalledOnce();
    await f.pump.stop();
  });
  it.each(['stale', 'heartbeat'])(
    'does not begin admission after %s during parser read',
    async (cause) => {
      let release: ((value: Awaited<ReturnType<ResolveParserNews>>) => void) | undefined;
      const f = fixture(
        () =>
          new Promise((done) => {
            release = done;
          }),
      );
      await start(f);
      vi.useFakeTimers();
      let stale = false;
      const payload = {
        ...batch([Buffer.from(JSON.stringify({ Source: 'Tass', Id: '0123456789abcdef01234567' }))]),
        isStale: () => stale,
      };
      const work = f.pump.eachBatch(payload);
      const settled = work.then(
        () => null,
        (error) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      if (cause === 'stale') stale = true;
      else {
        payload.heartbeat.mockRejectedValue(new Error('Heartbeat lost'));
        await vi.advanceTimersByTimeAsync(3000);
      }
      if (!release) throw new Error('Missing deferred read');
      release({
        source: 'Tass',
        externalId: 'publisher',
        title: 'Synthetic',
        text: '',
        publishedAt: event.PublishedAt,
        textCompleteness: 'lead',
      });
      const result = await settled;
      if (cause === 'heartbeat') expect(result).toBeInstanceOf(Error);
      else expect(result).toBeNull();
      expect(f.flow.ingest).not.toHaveBeenCalled();
      expect(f.port.commitOffsets).not.toHaveBeenCalled();
      await f.pump.stop();
    },
  );
  it('waits for an in-flight heartbeat before admission when parser read completes', async () => {
    let releaseRead: ((value: Awaited<ReturnType<ResolveParserNews>>) => void) | undefined;
    let rejectHeartbeat: ((reason: Error) => void) | undefined;
    const f = fixture(
      () =>
        new Promise((done) => {
          releaseRead = done;
        }),
    );
    await start(f);
    vi.useFakeTimers();
    const payload = batch([
      Buffer.from(JSON.stringify({ Source: 'Tass', Id: '0123456789abcdef01234567' })),
    ]);
    const work = f.pump.eachBatch(payload);
    const settled = work.then(
      () => null,
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    payload.heartbeat.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectHeartbeat = reject;
        }),
    );
    await vi.advanceTimersByTimeAsync(2500);
    if (!releaseRead) throw new Error('Missing deferred read');
    releaseRead({
      source: 'Tass',
      externalId: 'publisher',
      title: 'Synthetic',
      text: '',
      publishedAt: event.PublishedAt,
      textCompleteness: 'lead',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.flow.ingest).not.toHaveBeenCalled();
    expect(f.port.commitOffsets).not.toHaveBeenCalled();
    if (!rejectHeartbeat) throw new Error('Missing deferred heartbeat');
    rejectHeartbeat(new Error('Heartbeat lost after read'));
    expect(await settled).toBeInstanceOf(Error);
    expect(f.flow.ingest).not.toHaveBeenCalled();
    expect(f.port.commitOffsets).not.toHaveBeenCalled();
    await f.pump.stop();
  });
  it('rechecks stale state after a pending heartbeat settles and before admission', async () => {
    let releaseRead: ((value: Awaited<ReturnType<ResolveParserNews>>) => void) | undefined;
    let releaseHeartbeat: (() => void) | undefined;
    const f = fixture(
      () =>
        new Promise((done) => {
          releaseRead = done;
        }),
    );
    await start(f);
    vi.useFakeTimers();
    let stale = false;
    const payload = {
      ...batch([Buffer.from(JSON.stringify({ Source: 'Tass', Id: '0123456789abcdef01234567' }))]),
      isStale: () => stale,
    };
    const work = f.pump.eachBatch(payload);
    await vi.advanceTimersByTimeAsync(0);
    payload.heartbeat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseHeartbeat = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(2500);
    if (!releaseRead) throw new Error('Missing deferred read');
    releaseRead({
      source: 'Tass',
      externalId: 'publisher',
      title: 'Synthetic',
      text: '',
      publishedAt: event.PublishedAt,
      textCompleteness: 'lead',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.flow.ingest).not.toHaveBeenCalled();
    stale = true;
    if (!releaseHeartbeat) throw new Error('Missing deferred heartbeat');
    releaseHeartbeat();
    await work;
    expect(f.flow.ingest).not.toHaveBeenCalled();
    expect(f.port.commitOffsets).not.toHaveBeenCalled();
    await f.pump.stop();
  });
  it('leaves a transient parser failure uncommitted and can replay it', async () => {
    const resolve = vi
      .fn<ResolveParserNews>()
      .mockRejectedValueOnce(new NewsAnalysisError(502, 'PARSER_NEWS_UNAVAILABLE', 'Temporary'))
      .mockResolvedValue({
        source: 'Tass',
        externalId: 'publisher',
        title: 'Synthetic',
        text: '',
        publishedAt: event.PublishedAt,
        textCompleteness: 'lead',
      });
    const f = fixture(resolve);
    await start(f);
    const rawReference = Buffer.from(
      JSON.stringify({ Source: 'Tass', Id: '0123456789abcdef01234567' }),
    );
    const payload = batch([rawReference]);
    await expect(f.pump.eachBatch(payload)).rejects.toMatchObject({
      code: 'PARSER_NEWS_UNAVAILABLE',
    });
    expect(f.port.commitOffsets).not.toHaveBeenCalled();
    expect(f.flow.ingest).not.toHaveBeenCalled();
    expect(payload.pause).not.toHaveBeenCalled();
    await f.pump.eachBatch(batch([rawReference]));
    expect(f.port.commitOffsets).toHaveBeenCalledOnce();
    await f.pump.stop();
  });
  it('blocks an unresolved/mismatched parser reference without leaking or acknowledging the payload', async () => {
    for (const resolve of [
      undefined,
      vi.fn<ResolveParserNews>(async () => {
        throw new NewsAnalysisError(422, 'PARSER_NEWS_SOURCE_MISMATCH', 'Mismatch');
      }),
    ]) {
      const f = fixture(resolve);
      await start(f);
      const payload = batch([
        Buffer.from(JSON.stringify({ Source: 'Tass', Id: '0123456789abcdef01234567' })),
        raw,
      ]);
      await f.pump.eachBatch(payload);
      expect(payload.pause).toHaveBeenCalledOnce();
      expect(f.flow.ingest).not.toHaveBeenCalled();
      expect(f.port.commitOffsets).not.toHaveBeenCalled();
      expect(f.pump.status().blocked[0]?.code).toBe('INGRESS_REJECTED');
      await f.pump.stop();
    }
  });
  it('does not read parser for legacy replay messages', async () => {
    const resolve = vi.fn<ResolveParserNews>();
    const f = fixture(resolve);
    await start(f);
    await f.pump.eachBatch(batch());
    expect(resolve).not.toHaveBeenCalled();
    expect(f.flow.ingest).toHaveBeenCalledOnce();
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
