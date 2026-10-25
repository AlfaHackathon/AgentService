import { type ChildProcess, fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createFlueClient } from '@flue/sdk';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { readSql } from '../src/shared/read-sql.ts';
import type { Sql } from '../src/shared/sql.ts';
import { createHttpService } from './helpers/http-service.ts';
import { aliceUserId, bobUserId, gatewayHeaders } from './helpers/identity.ts';
import { createLlmServer } from './helpers/llm-server.ts';

const listMigrationsSql = readSql('migrations/list.sql');

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

let database: Sql;
let sqlServer: PGLiteSocketServer | undefined;
let databaseUrl: string;
let closeDatabase: () => Promise<void>;
let model: Awaited<ReturnType<typeof createLlmServer>>;
let child: ChildProcess | undefined;
let baseUrl: string;
let port: number;
let output = '';

async function startServer(environment: NodeJS.ProcessEnv = {}) {
  child = fork('dist/service.mjs', [], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      // The embedded database has one underlying PG session, even through its socket multiplexer.
      DATABASE_POOL_MAX: process.env.TEST_DATABASE_URL ? '10' : '1',
      PORT: String(port),
      LLM_BASE_URL: model.url,
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  output = '';
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });
  await vi.waitFor(
    async () => {
      if (child?.exitCode !== null) throw new Error(`Server exited: ${output}`);
      expect((await fetch(`${baseUrl}/ready`)).status, output).toBe(200);
    },
    { timeout: 20000, interval: 100 },
  );
}

async function stopServer(force = false) {
  if (!child || child.exitCode !== null) return;
  const stopped = once(child, 'exit');
  if (force) child.kill('SIGKILL');
  else child.disconnect();
  await stopped;
  child = undefined;
}

beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    database = pool;
    databaseUrl = process.env.TEST_DATABASE_URL;
    closeDatabase = () => pool.end();
  } else {
    const embedded = new PGlite();
    database = embedded;
    sqlServer = new PGLiteSocketServer({
      db: embedded,
      host: '127.0.0.1',
      port: await freePort(),
      maxConnections: 20,
    });
    await sqlServer.start();
    databaseUrl = `postgresql://postgres:postgres@${sqlServer.getServerConn()}/postgres`;
    closeDatabase = () => embedded.close();
  }
  model = await createLlmServer();
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}/agent-service`;
  await startServer();
});

afterAll(async () => {
  await stopServer();
  await model?.close();
  await sqlServer?.stop();
  await closeDatabase?.();
});

afterEach((context) => {
  if (context.task.result?.state === 'fail') console.error(output);
});

it('runs the built server with pg, migrations, native SSE and a process restart', async () => {
  expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  const headers = { ...gatewayHeaders(), 'Content-Type': 'application/json' };
  const created = await fetch(`${baseUrl}/chats`, {
    method: 'POST',
    headers,
    body: '{"title":"Рабочий чат"}',
  });
  expect(created.status).toBe(201);
  const chat: { id: string } = await created.json();
  const client = createFlueClient({
    url: `${baseUrl}/agents/assistant/${chat.id}`,
    headers: gatewayHeaders(),
  });
  expect(
    (await client.read(await client.send({ message: { kind: 'user', body: 'persisted-input' } })))
      .text,
  ).toContain('persisted-input');
  expect((await fetch(client.url, { headers: gatewayHeaders(bobUserId) })).status).toBe(404);
  await stopServer();
  await startServer();
  expect(
    (await client.read(await client.send({ message: { kind: 'user', body: 'after-restart' } })))
      .text,
  ).toContain('persisted-input | after-restart');
  const migrations = await database.query<{ name: string }>(listMigrationsSql);
  expect(migrations.rows.map((row) => row.name)).toEqual(['001_chats.sql']);
});

it('recovers accepted active and queued work after an abrupt process death', async () => {
  const created = await fetch(`${baseUrl}/chats`, {
    method: 'POST',
    headers: { ...gatewayHeaders(), 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(created.status).toBe(201);
  const chat: { id: string } = await created.json();
  const client = createFlueClient({
    url: `${baseUrl}/agents/assistant/${chat.id}`,
    headers: gatewayHeaders(),
  });
  const requestCount = model.requests.length;
  const active = await client.send({ message: { kind: 'user', body: 'slow-before-crash' } });
  await vi.waitFor(() => expect(model.requests.length).toBeGreaterThan(requestCount));
  const queued = await client.send({ message: { kind: 'user', body: 'queued-before-crash' } });
  await stopServer(true);
  model.allowSlowResponses();
  await startServer();
  const signal = AbortSignal.timeout(70000);
  expect((await client.read(active, { signal })).text).toContain('slow-before-crash');
  expect((await client.read(queued, { signal })).text).toContain('queued-before-crash');
  expect(
    (await client.history()).messages.filter((message) => message.role === 'user'),
  ).toHaveLength(2);
});

it('lets the chat CLI finish its answer after stdin EOF without prompting a closed readline', async () => {
  const cli = spawn(process.execPath, ['--experimental-strip-types', 'scripts/chat.ts'], {
    env: {
      ...process.env,
      AGENT_SERVICE_URL: baseUrl,
      AGENT_SERVICE_TOKEN: '',
      AGENT_SERVICE_USER_ID: aliceUserId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  cli.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  cli.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  cli.stdin.end('cli-eof-check\n/exit\n');
  const [code] = await once(cli, 'exit');
  expect(code, stderr).toBe(0);
  expect(stdout).toContain('История: cli-eof-check');
  expect(stderr).not.toContain('ERR_USE_AFTER_CLOSE');
});

it('dispatches both company phases through the agents registered in the built application', async () => {
  const asOf = '2026-10-22T08:00:00Z';
  const request = {
    companyId: '11111111-1111-4111-8111-111111111111',
    newsMaterialId: 'synthetic-built-news',
    newsVersionId: 'v1',
    asOf,
  };
  const writes: unknown[] = [];
  const modelRequests: unknown[] = [];
  const upstream = await createHttpService(async (incoming) => {
    expect(incoming.headers.get('X-Internal-Secret')).toBe('built-news-test-secret');
    const path = new URL(incoming.url).pathname;
    if (path.endsWith('/news-jobs/claim')) return Response.json(null);
    if (path.endsWith('/internal/context'))
      return Response.json({
        news: {
          materialId: request.newsMaterialId,
          versionId: 'v1',
          sourceId: 'synthetic-source',
          kind: 'news',
          title: 'Synthetic news',
          text: 'Synthetic event without confirmed exposure.',
          knownAt: asOf,
          companyIds: [],
          bankProfileIds: [],
          contentHash: 'a'.repeat(64),
        },
        materials: [],
        coverage: {
          complete: true,
          materialCount: 0,
          companyMaterialCount: 0,
          marketMaterialCount: 0,
          previousNewsVersionCount: 0,
          characters: 100,
          asOf,
        },
      });
    if (path.endsWith('/internal/analyses/prepare')) return Response.json({ drafts: [] });
    if (path.endsWith('/internal/analyses/session'))
      return Response.json({ receipt: null, previousEffects: [] });
    if (path.endsWith('/internal/effects')) return Response.json({ effects: [] });
    if (path.endsWith('/calculations/preview')) return Response.json([]);
    if (path.endsWith('/internal/analyses')) {
      if (incoming.method === 'GET') return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
      writes.push(await incoming.json());
      return Response.json({
        ...request,
        analysisId: 'synthetic-built-analysis',
        duplicate: false,
        resultSemantics: 'saved_analysis_revisions_not_latest_heads',
        completedAt: asOf,
        effects: [],
      });
    }
    return Response.json({ code: 'UNEXPECTED_PATH' }, { status: 404 });
  });
  const llm = await createHttpService(async (incoming) => {
    expect(incoming.headers.get('authorization')).toBe('Bearer test-only-key');
    modelRequests.push(await incoming.json());
    const chunk = (delta: unknown, finish: string | null) =>
      `data: ${JSON.stringify({
        id: `synthetic-${modelRequests.length}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    return new Response(
      chunk({ role: 'assistant' }, null) +
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: 'synthetic-result',
                type: 'function',
                function: { name: 'submit_news_analysis', arguments: '{"drafts":[]}' },
              },
            ],
          },
          null,
        ) +
        chunk({}, 'tool_calls') +
        'data: [DONE]\n\n',
      {
        headers: { 'Content-Type': 'text/event-stream' },
      },
    );
  });
  try {
    await stopServer();
    await startServer({
      INTERNAL_SECRET: 'built-news-test-secret',
      COMPANY_SERVICE_URL: `${upstream.url}/company-service`,
      CONTEXT_SERVICE_URL: `${upstream.url}/context-service`,
      INSIGHT_SERVICE_URL: `${upstream.url}/insight-service`,
      LLM_BASE_URL: `${llm.url}/v1`,
    });
    const response = await fetch(`${baseUrl}/internal/news-analysis`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': 'built-news-test-secret',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({
      analysisId: 'synthetic-built-analysis',
      reasoningInvoked: true,
      effects: [],
    });
    expect(modelRequests).toHaveLength(2);
    expect(writes).toEqual([
      {
        ...request,
        drafts: [],
        contextComplete: true,
        retrievalTrace: [
          {
            round: 0,
            queries: [],
            retrievedSources: [
              { materialId: request.newsMaterialId, versionId: 'v1', contentHash: 'a'.repeat(64) },
            ],
            stopReason: 'agent_tools',
          },
        ],
      },
    ]);
  } finally {
    await stopServer();
    await llm.close();
    await upstream.close();
    await startServer();
  }
});

it('serves opt-in Swagger and local assets from the built server without changing chat authentication', async () => {
  await stopServer();
  await startServer({ SWAGGER_ENABLED: 'true' });
  const spec = await fetch(`${baseUrl}/swagger/v1/swagger.json`);
  expect(spec.status).toBe(200);
  expect(await spec.json()).toMatchObject({ openapi: '3.1.0' });
  for (const asset of ['index.html', 'swagger-ui-bundle.js', 'swagger-ui.css'])
    expect((await fetch(`${baseUrl}/swagger/${asset}`)).status).toBe(200);
  expect((await fetch(`${baseUrl}/chats`)).status).toBe(401);
});
