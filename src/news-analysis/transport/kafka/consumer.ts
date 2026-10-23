import { createHash } from 'node:crypto';
import { type Consumer, type EachBatchPayload, Kafka, logLevel, type SASLOptions } from 'kafkajs';
import { z } from 'zod';
import type { NewsFlow } from '../../application/news-flow.ts';
import { NewsAnalysisError } from '../../contracts/errors.ts';
import { parseNewsKafkaEvent } from '../../contracts/news-event.ts';

const field = (max: number) => z.string().trim().min(1).max(max);
const flag = z.enum(['true', 'false']);
const settingsSchema = z
  .object({
    KAFKA_BROKERS: z
      .string()
      .min(1)
      .transform((s) => s.split(',').map((b) => b.trim()))
      .pipe(
        z
          .array(z.string().regex(/^[^\s/:]+:\d{1,5}$/))
          .min(1)
          .max(16),
      ),
    NEWS_KAFKA_TOPIC: field(249).default('news-parser.news'),
    NEWS_KAFKA_GROUP_ID: field(249).default('agent-service-news-v1'),
    NEWS_KAFKA_FROM_BEGINNING: flag.default('true'),
    KAFKA_SSL: flag.default('false'),
    KAFKA_SASL_MECHANISM: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).optional(),
    KAFKA_SASL_USERNAME: z.string().min(1).optional(),
    KAFKA_SASL_PASSWORD: z.string().min(1).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.KAFKA_SASL_MECHANISM && (!s.KAFKA_SASL_USERNAME || !s.KAFKA_SASL_PASSWORD))
      ctx.addIssue({ code: 'custom', message: 'Kafka SASL credentials required' });
    if (!s.KAFKA_SASL_MECHANISM && (s.KAFKA_SASL_USERNAME || s.KAFKA_SASL_PASSWORD))
      ctx.addIssue({ code: 'custom', message: 'Kafka SASL mechanism required' });
  });
type Port = Pick<
  Consumer,
  'connect' | 'subscribe' | 'run' | 'commitOffsets' | 'stop' | 'disconnect'
>;
type Log = (entry: Record<string, unknown>) => void;
type Blocked = {
  topic: string;
  partition: number;
  offset: string;
  code: string;
  payloadHash: string | null;
};

export class NewsKafkaConsumer {
  private phase: 'stopped' | 'connecting' | 'running' | 'retrying' = 'stopped';
  private stopped = true;
  private connecting: Promise<void> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly blocked = new Map<string, Blocked>();
  private lastAccepted: { topic: string; partition: number; offset: string; jobId: string } | null =
    null;
  private readonly consumer: Port;
  private readonly flow: Pick<NewsFlow, 'ingest'>;
  private readonly topic: string;
  private readonly groupId: string;
  private readonly fromBeginning: boolean;
  private readonly log: Log;
  constructor(
    consumer: Port,
    flow: Pick<NewsFlow, 'ingest'>,
    topic: string,
    groupId: string,
    fromBeginning = true,
    log: Log = (entry) => console.log(JSON.stringify(entry)),
  ) {
    this.consumer = consumer;
    this.flow = flow;
    this.topic = topic;
    this.groupId = groupId;
    this.fromBeginning = fromBeginning;
    this.log = log;
  }
  status() {
    return {
      status: this.blocked.size ? 'blocked' : this.phase,
      topic: this.topic,
      groupId: this.groupId,
      blocked: [...this.blocked.values()],
      lastAccepted: this.lastAccepted,
    };
  }
  ready() {
    if (this.phase !== 'running' || this.blocked.size)
      throw new Error('News Kafka consumer is not ready');
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connecting = this.connect();
  }
  private async connect() {
    this.phase = 'connecting';
    try {
      await this.consumer.connect();
      if (this.stopped) return;
      await this.consumer.subscribe({ topics: [this.topic], fromBeginning: this.fromBeginning });
      if (this.stopped) return;
      await this.consumer.run({
        autoCommit: false,
        eachBatchAutoResolve: false,
        partitionsConsumedConcurrently: 1,
        eachBatch: (payload) => this.eachBatch(payload),
      });
    } catch {
      if (!this.stopped) {
        this.phase = 'retrying';
        this.log({ event: 'news.kafka.unavailable', code: 'CONNECT_FAILED' });
        await this.consumer.disconnect().catch(() => {});
        this.schedule();
      }
    }
  }
  private schedule() {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (!this.stopped) this.connecting = this.connect();
    }, 10000);
    this.retry.unref();
  }
  crashed(willRestart: boolean) {
    if (this.stopped) return;
    this.phase = 'retrying';
    this.log({ event: 'news.kafka.unavailable', code: 'CONSUMER_CRASH', willRestart });
    if (!willRestart) this.schedule();
  }
  joined() {
    if (!this.stopped) this.phase = 'running';
  }
  disconnected() {
    if (!this.stopped) this.phase = 'retrying';
  }
  async stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    await this.connecting;
    await this.consumer.stop();
    await this.consumer.disconnect();
    this.phase = 'stopped';
  }
  async eachBatch({
    batch,
    isRunning,
    isStale,
    pause,
    resolveOffset,
    heartbeat,
  }: EachBatchPayload) {
    for (const message of batch.messages) {
      if (this.stopped || !isRunning() || isStale()) break;
      let event: ReturnType<typeof parseNewsKafkaEvent>;
      try {
        event = parseNewsKafkaEvent(message.value);
      } catch {
        this.block(batch.topic, batch.partition, message.offset, message.value, 'INVALID_EVENT');
        pause();
        break;
      }
      await heartbeat();
      let job: Awaited<ReturnType<NewsFlow['ingest']>>;
      let heartbeatFailure: unknown;
      let pendingHeartbeat = Promise.resolve();
      const timer = setInterval(() => {
        pendingHeartbeat = pendingHeartbeat.then(heartbeat).catch((error: unknown) => {
          heartbeatFailure = error;
        });
      }, 2500);
      timer.unref();
      try {
        job = await this.flow.ingest(event);
      } catch (error) {
        if (
          error instanceof z.ZodError ||
          (error instanceof NewsAnalysisError && [400, 403, 409, 422].includes(error.status))
        ) {
          this.block(
            batch.topic,
            batch.partition,
            message.offset,
            message.value,
            'INGRESS_REJECTED',
          );
          pause();
          break;
        }
        this.log({
          event: 'news.kafka.admission_failed',
          topic: batch.topic,
          partition: batch.partition,
          offset: message.offset,
          code: 'UPSTREAM_UNAVAILABLE',
        });
        throw error;
      } finally {
        clearInterval(timer);
        await pendingHeartbeat;
      }
      if (heartbeatFailure) throw heartbeatFailure;
      // Admission writes only exact material + durable job (bounded HTTP calls),
      // never waits on the LLM. A rebalance/shutdown leaves the offset for replay.
      if (this.stopped || !isRunning() || isStale()) break;
      await heartbeat();
      await this.consumer.commitOffsets([
        {
          topic: batch.topic,
          partition: batch.partition,
          offset: (BigInt(message.offset) + 1n).toString(),
        },
      ]);
      resolveOffset(message.offset);
      this.lastAccepted = {
        topic: batch.topic,
        partition: batch.partition,
        offset: message.offset,
        jobId: job.request.jobId,
      };
      this.log({ event: 'news.kafka.admitted', ...this.lastAccepted });
    }
  }
  private block(
    topic: string,
    partition: number,
    offset: string,
    value: Buffer | null,
    code: string,
  ) {
    const blocked = {
      topic,
      partition,
      offset,
      code,
      payloadHash: value ? createHash('sha256').update(value).digest('hex') : null,
    };
    this.blocked.set(`${topic}:${partition}`, blocked);
    this.log({ event: 'news.kafka.blocked', ...blocked });
  }
}

export function createNewsKafkaConsumer(
  flow: Pick<NewsFlow, 'ingest'>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.NEWS_KAFKA_ENABLED !== 'true') {
    if (environment.NEWS_KAFKA_ENABLED && environment.NEWS_KAFKA_ENABLED !== 'false')
      throw new Error('NEWS_KAFKA_ENABLED must be true or false');
    return undefined;
  }
  const parsed = settingsSchema.safeParse(environment);
  if (!parsed.success) throw new Error('Invalid news Kafka configuration');
  const s = parsed.data;
  const credentials =
    s.KAFKA_SASL_USERNAME && s.KAFKA_SASL_PASSWORD
      ? { username: s.KAFKA_SASL_USERNAME, password: s.KAFKA_SASL_PASSWORD }
      : undefined;
  const sasl: SASLOptions | undefined = !credentials
    ? undefined
    : s.KAFKA_SASL_MECHANISM === 'plain'
      ? { mechanism: 'plain', ...credentials }
      : s.KAFKA_SASL_MECHANISM === 'scram-sha-256'
        ? { mechanism: 'scram-sha-256', ...credentials }
        : { mechanism: 'scram-sha-512', ...credentials };
  const consumer = new Kafka({
    clientId: 'agent-service-news',
    brokers: s.KAFKA_BROKERS,
    ssl: s.KAFKA_SSL === 'true',
    ...(sasl ? { sasl } : {}),
    connectionTimeout: 3000,
    requestTimeout: 15000,
    retry: { retries: 5, maxRetryTime: 3000 },
    logLevel: logLevel.NOTHING,
  }).consumer({
    groupId: s.NEWS_KAFKA_GROUP_ID,
    sessionTimeout: 60000,
    heartbeatInterval: 3000,
    allowAutoTopicCreation: false,
  });
  const pump = new NewsKafkaConsumer(
    consumer,
    flow,
    s.NEWS_KAFKA_TOPIC,
    s.NEWS_KAFKA_GROUP_ID,
    s.NEWS_KAFKA_FROM_BEGINNING === 'true',
  );
  consumer.on(consumer.events.CRASH, ({ payload }) => pump.crashed(payload.restart));
  consumer.on(consumer.events.GROUP_JOIN, () => pump.joined());
  consumer.on(consumer.events.DISCONNECT, () => pump.disconnected());
  return pump;
}
