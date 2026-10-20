import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { postgres } from '@flue/postgres';
import { init } from '@flue/runtime';
import { type Flue, start } from '@flue/runtime/node';
import { createAgentRouter } from '@flue/runtime/routing';
import { createFlueClient } from '@flue/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientAssistantAgent } from '../src/agents/client-assistant.ts';
import { CompanyResearchAgent } from '../src/agents/company-research.ts';
import { InsightAgent } from '../src/agents/insight.ts';
import { ScenarioAgent } from '../src/agents/scenario.ts';
import { createApplication } from '../src/application.ts';
import { ChatRepository } from '../src/chats/repository.ts';
import { createModelProvider } from '../src/config/model.ts';
import { createTestDatabase } from './helpers/database.ts';
import { aliceUserId, gatewayHeaders } from './helpers/identity.ts';
import { createLlmServer } from './helpers/llm-server.ts';

describe('real Flue + PostgreSQL adapter + SDK + HTTP model', () => {
  let db: PGlite;
  let runtime: Flue;
  let model: Awaited<ReturnType<typeof createLlmServer>>;
  let app: ReturnType<typeof createApplication>;
  let chats: ChatRepository;

  async function boot() {
    return start({
      agents: [ClientAssistantAgent, CompanyResearchAgent, InsightAgent, ScenarioAgent],
      providers: [createModelProvider({ ...process.env, LLM_BASE_URL: model.url })],
      db: postgres({
        query: async (sql, params) => (await db.query<Record<string, unknown>>(sql, params)).rows,
        transaction: (work) =>
          db.transaction((tx) =>
            work({
              query: async (sql, params) =>
                (await tx.query<Record<string, unknown>>(sql, params)).rows,
            }),
          ),
        close: () => {},
      }),
    });
  }

  beforeEach(async () => {
    db = await createTestDatabase();
    model = await createLlmServer();
    runtime = await boot();
    chats = new ChatRepository(db);
    app = createApplication({
      chats,
      agentRouter: createAgentRouter(ClientAssistantAgent),
      ready: async () => {},
      log: () => {},
    });
  });
  afterEach(async () => {
    await runtime?.stop();
    await model?.close();
    await db?.close();
  });

  function client(id: string) {
    return createFlueClient({
      url: `http://agent.test/agents/assistant/${id}`,
      headers: gatewayHeaders(),
      fetch: async (input, options) => app.fetch(new Request(input, options)),
    });
  }

  it('streams answers, isolates chats, keeps multi-turn context and deduplicates native deliveries', async () => {
    const a = client((await chats.create(aliceUserId)).id);
    const b = client((await chats.create(aliceUserId)).id);
    const uppercase = client(a.url.split('/').at(-1)?.toUpperCase() ?? '');
    await expect(
      uppercase.send({ message: { kind: 'user', body: 'alternate-case' } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(a.history()).rejects.toMatchObject({ status: 404 });
    const receipt = await a.send({
      message: { kind: 'user', body: 'alpha' },
      idempotencyKey: 'delivery-1',
    });
    const events: string[] = [];
    expect(
      (
        await a.read(receipt, {
          onEvent: (event) => {
            events.push(event.type);
          },
        })
      ).text,
    ).toContain('alpha');
    expect(events.length).toBeGreaterThan(1);
    const replay = await a.send({
      message: { kind: 'user', body: 'alpha' },
      idempotencyKey: 'delivery-1',
    });
    expect(replay).toMatchObject({ submissionId: receipt.submissionId, deduplicated: true });
    expect(
      (await a.read(await a.send({ message: { kind: 'user', body: 'beta' } }))).text,
    ).toContain('alpha | beta');
    const other = await b.read(await b.send({ message: { kind: 'user', body: 'gamma' } }));
    expect(other.text).toContain('gamma');
    expect(other.text).not.toContain('alpha');
    expect(model.requests).toHaveLength(3);
    const reconnected = client(a.url.split('/').at(-1) ?? '');
    expect((await reconnected.history()).messages.length).toBeGreaterThanOrEqual(4);
    expect((await reconnected.read(receipt.submissionId)).text).toContain('alpha');
  });

  it('reloads native history after runtime replacement and starts a background definition', async () => {
    const a = client((await chats.create(aliceUserId)).id);
    await a.read(await a.send({ message: { kind: 'user', body: 'remember-me' } }));
    await runtime.stop();
    runtime = await boot();
    expect(
      (await a.read(await a.send({ message: { kind: 'user', body: 'next-turn' } }))).text,
    ).toContain('remember-me | next-turn');
    const research = init(CompanyResearchAgent, { id: randomUUID() });
    expect((await research.read(await research.dispatch('company-context'))).text).toContain(
      'company-context',
    );
    expect(JSON.stringify(await a.history())).not.toContain('company-context');
  });

  it('aborts active and queued work in one chat while another chat completes', async () => {
    const a = client((await chats.create(aliceUserId)).id);
    const b = client((await chats.create(aliceUserId)).id);
    const active = await a.send({ message: { kind: 'user', body: 'slow-running' } });
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    const queued = await a.send({ message: { kind: 'user', body: 'queued' } });
    expect((await a.abort()).aborted).toBe(true);
    await expect(a.read(active)).rejects.toMatchObject({ failure: 'aborted' });
    await expect(a.read(queued)).rejects.toMatchObject({ failure: 'aborted' });
    expect(
      (await b.read(await b.send({ message: { kind: 'user', body: 'other-chat' } }))).text,
    ).toContain('other-chat');
  });

  it('reports provider rejection as a failed submission', async () => {
    const a = client((await chats.create(aliceUserId)).id);
    const receipt = await a.send({ message: { kind: 'user', body: 'fail' } });
    await expect(a.read(receipt)).rejects.toMatchObject({ failure: 'failed' });
  });
});
