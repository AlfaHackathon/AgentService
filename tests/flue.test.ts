import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import * as assistantConfiguration from '../src/client-assistant/configuration.ts';
import { AssistantServiceClients } from '../src/client-assistant/service-clients.ts';
import { createModelProvider } from '../src/config/model.ts';
import { ServiceClient } from '../src/news-analysis/transport/http/service-client.ts';
import { createTestDatabase } from './helpers/database.ts';
import { aliceUserId, bobUserId, gatewayHeaders } from './helpers/identity.ts';
import { createLlmServer } from './helpers/llm-server.ts';

const setChatTimestampSql = readFileSync(
  new URL('./sql/set-chat-timestamp.sql', import.meta.url),
  'utf8',
);

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
    vi.restoreAllMocks();
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
    expect(model.requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining([
        'assistant_company_profile',
        'assistant_search_context',
        'assistant_read_original',
        'assistant_news_insights',
        'assistant_analyze_news',
      ]),
    );
    for (const tool of model.requests[0]?.tools ?? []) {
      if (!tool.function.name.startsWith('assistant_')) continue;
      expect(tool.function.parameters.additionalProperties).toBe(false);
      expect(JSON.stringify(tool.function.parameters)).not.toMatch(
        /"(companyId|userId|ownerId|secret|asOf)"/,
      );
    }
    const reconnected = client(a.url.split('/').at(-1) ?? '');
    expect((await reconnected.history()).messages.length).toBeGreaterThanOrEqual(4);
    expect((await reconnected.read(receipt.submissionId)).text).toContain('alpha');
  });

  it('executes a service tool through native admission/SSE using the catalogue owner and preserving native uid conditions', async () => {
    await runtime.stop();
    await model.close();
    model = await createLlmServer({ name: 'assistant_company_profile', arguments: {} });
    runtime = await boot();
    const companyId = '11111111-1111-4111-8111-111111111111';
    const membershipOwners: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/by-user/')) {
        membershipOwners.push(url.pathname.split('/').at(-1) ?? '');
        return Response.json({ id: companyId, name: 'Own company', bankProfileId: null });
      }
      return Response.json({
        companyId,
        name: 'Own company',
        revisionId: 'p1',
        bankProfileId: null,
        description: 'Verified fixture profile',
        industryCodes: [],
        exposures: [],
        knownAt: '2026-10-20T00:00:00Z',
        sourceRefs: [],
      });
    };
    const http = new ServiceClient('http://fixture.test', 'fixture-secret', fetcher);
    vi.spyOn(assistantConfiguration, 'createAssistantDependencies').mockResolvedValue({
      owner: (id) => chats.owner(id),
      clients: new AssistantServiceClients(http, http, http),
      analyzer: {
        analyze: async () => {
          throw new Error('Reading must not start analysis');
        },
      },
    });
    const chat = await chats.create(aliceUserId);
    const response = await app.request(`/agents/assistant/${chat.id}`, {
      method: 'POST',
      headers: { ...gatewayHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'user', body: 'Read my profile', uid: bobUserId }),
    });
    expect(response.status).toBe(404);
    expect(membershipOwners).toEqual([]);
    const a = client(chat.id);
    const receipt = await a.send({ message: { kind: 'user', body: 'Read my profile' } });
    expect(receipt.uid).not.toBe(aliceUserId);
    expect(receipt.uid).not.toBe(bobUserId);
    expect((await a.read(receipt)).text).toContain('Own company');
    const next = await a.send({
      message: { kind: 'user', body: 'Read it again' },
      uid: receipt.uid,
    });
    expect((await a.read(next)).text).toContain('Own company');
    expect(membershipOwners).toEqual([aliceUserId, aliceUserId]);
  });

  it('keeps a deduplicated delivery from changing chat activity or paginated order', async () => {
    const chat = await chats.create(aliceUserId);
    const a = client(chat.id);
    const input = {
      message: { kind: 'user' as const, body: 'accepted-once' },
      idempotencyKey: 'retry-old-delivery',
    };
    const oldTimestamp = '2000-01-01T00:00:00.000Z';
    await db.query(setChatTimestampSql, [oldTimestamp]);
    const receipt = await a.send(input);
    expect((await chats.get(chat.id, aliceUserId))?.updatedAt).not.toBe(oldTimestamp);
    await a.read(receipt);

    // Make the accepted delivery older than a second chat without timing assumptions.
    await db.query(setChatTimestampSql, [oldTimestamp]);
    const newer = await chats.create(aliceUserId);
    const list = (cursor?: string) =>
      app.request(`/chats?limit=1${cursor ? `&cursor=${cursor}` : ''}`, {
        headers: gatewayHeaders(),
      });
    const firstPage: { items: { id: string }[]; nextCursor: string } = await (await list()).json();
    expect(firstPage.items.map((item) => item.id)).toEqual([newer.id]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    expect(await a.send(input)).toMatchObject({
      submissionId: receipt.submissionId,
      deduplicated: true,
    });
    const metadata = await app.request(`/chats/${chat.id}`, { headers: gatewayHeaders() });
    expect(await metadata.json()).toMatchObject({ updatedAt: oldTimestamp });
    expect(await (await list()).json()).toMatchObject({ items: [{ id: newer.id }] });
    expect(await (await list(firstPage.nextCursor)).json()).toMatchObject({
      items: [{ id: chat.id }],
      nextCursor: null,
    });
    expect(model.requests).toHaveLength(1);
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
