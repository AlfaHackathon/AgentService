import { type ChildProcess, execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { createFlueClient } from '@flue/sdk';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { bobUserId, gatewayHeaders } from './helpers/identity.ts';

const execute = promisify(execFile);
let child: ChildProcess | undefined;
let baseUrl: string;

beforeAll(async () => {
  for (const key of ['DATABASE_URL', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']) {
    if (!process.env[key]) throw new Error(`Set ${key} for live integration tests`);
  }
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  baseUrl = `http://127.0.0.1:${port}/agent-service`;
  child = fork('dist/service.mjs', [], {
    env: { ...process.env, PORT: String(port), DATABASE_POOL_MAX: '10' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  await vi.waitFor(
    async () => {
      if (child?.exitCode !== null) throw new Error('Live test server exited during startup');
      expect((await fetch(`${baseUrl}/ready`)).status).toBe(200);
    },
    { timeout: 20000, interval: 100 },
  );
});

afterAll(async () => {
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit');
    child.disconnect();
    await stopped;
  }
});

async function createChat(title: string) {
  const response = await fetch(`${baseUrl}/chats`, {
    method: 'POST',
    headers: { ...gatewayHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  expect(response.status).toBe(201);
  const chat: { id: string } = await response.json();
  return {
    chat,
    client: createFlueClient({
      url: `${baseUrl}/agents/assistant/${chat.id}`,
      headers: gatewayHeaders(),
    }),
  };
}

it('checks the gateway boundary, catalogue, archive and restoration against real PostgreSQL', async () => {
  const { chat, client } = await createChat(`Live catalogue ${randomUUID()}`);
  expect((await fetch(`${baseUrl}/chats`)).status).toBe(401);
  expect((await fetch(client.url, { headers: gatewayHeaders(bobUserId) })).status).toBe(404);
  const patch = (body: Record<string, unknown>) =>
    fetch(`${baseUrl}/chats/${chat.id}`, {
      method: 'PATCH',
      headers: { ...gatewayHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await patch({ title: 'Проверенный чат', archived: true })).status).toBe(200);
  await expect(
    client.send({ message: { kind: 'user', body: 'Archived message' } }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await patch({ archived: false })).status).toBe(200);
  const metadata = await fetch(`${baseUrl}/chats/${chat.id}`, { headers: gatewayHeaders() });
  expect(await metadata.json()).toMatchObject({
    id: chat.id,
    title: 'Проверенный чат',
    archivedAt: null,
  });
});

it('streams real model output, remembers chat context, deduplicates delivery and isolates a second chat', async () => {
  const a = await createChat('Live model A');
  const b = await createChat('Live model B');
  const marker = `ALFA_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const input = {
    message: {
      kind: 'user' as const,
      body: `Запомни проверочный код ${marker}. Ответь коротко, что запомнил.`,
    },
    idempotencyKey: randomUUID(),
  };
  const admission = await a.client.send(input);
  let textDeltas = 0;
  const response = await a.client.read(admission, {
    signal: AbortSignal.timeout(90000),
    onEvent: (event) => {
      if (event.type === 'message-delta' && event.kind === 'text') textDeltas++;
    },
  });
  expect(response.text.trim().length).toBeGreaterThan(0);
  expect(textDeltas).toBeGreaterThan(0);
  expect(await a.client.send(input)).toMatchObject({
    submissionId: admission.submissionId,
    deduplicated: true,
  });
  const [remembered, separate] = await Promise.all([
    a.client.read(
      await a.client.send({
        message: {
          kind: 'user',
          body: 'Какой проверочный код я просил запомнить? Напиши только сам код.',
        },
      }),
      { signal: AbortSignal.timeout(90000) },
    ),
    b.client.read(
      await b.client.send({
        message: {
          kind: 'user',
          body: 'Это новый диалог для технической проверки. Ответь кратко: новый диалог.',
        },
      }),
      { signal: AbortSignal.timeout(90000) },
    ),
  ]);
  expect(remembered.text).toContain(marker);
  expect(separate.text.trim().length).toBeGreaterThan(0);
  expect(JSON.stringify(await b.client.history())).not.toContain(marker);
  expect(
    (await a.client.history()).messages.filter((message) => message.role === 'user'),
  ).toHaveLength(2);
});

it.each(['company-research', 'insight', 'scenario'])(
  'runs background %s through the real Flue CLI and model',
  async (name) => {
    const result = await execute(
      process.execPath,
      [
        'node_modules/@flue/cli/bin/flue.mjs',
        'run',
        `src/agents/${name}.ts`,
        '--id',
        `live-${name}-${randomUUID()}`,
        '--json',
        '--message',
        'Техническая проверка. Компания производит мебель, закупает древесину и хочет снизить задержки поставок. Дай одно краткое наблюдение по своей роли, без выдуманных данных.',
      ],
      { env: process.env, timeout: 100000, maxBuffer: 1024 * 1024 },
    );
    const reply: { outcome: string; message: string } = JSON.parse(result.stdout);
    expect(reply.outcome).toBe('completed');
    expect(reply.message.trim().length).toBeGreaterThan(0);
  },
);
