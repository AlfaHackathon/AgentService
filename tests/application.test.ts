import type { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication, mountService } from '../src/application.ts';
import { ChatRepository } from '../src/chats/repository.ts';
import { readSql } from '../src/shared/read-sql.ts';
import { createTestDatabase } from './helpers/database.ts';
import { aliceUserId, bobUserId } from './helpers/identity.ts';

const readinessSql = readSql('connection/ready.sql');

describe('HTTP access and metadata', () => {
  let db: PGlite;
  let chats: ChatRepository;
  let app: ReturnType<typeof createApplication>;
  const alice = aliceUserId;
  const bob = bobUserId;
  const admitted = vi.fn();
  const log = vi.fn();
  beforeEach(async () => {
    db = await createTestDatabase();
    chats = new ChatRepository(db);
    admitted.mockClear();
    log.mockClear();
    const router = new Hono();
    router.post('/:id', (c) => {
      admitted(c.req.url);
      return c.json({ submissionId: 'submission-1' }, 202);
    });
    router.get('/:id', (c) => c.json({ messages: [] }));
    router.post('/:id/abort', (c) => c.json({ aborted: true }));
    app = createApplication({
      chats,
      agentRouter: router,
      ready: async () => {
        await db.query(readinessSql);
      },
      log,
    });
  });
  afterEach(async () => {
    if (!db.closed) await db.close();
  });

  const headers = (userId: string) => ({
    'X-User-Id': userId,
    'Content-Type': 'application/json',
  });

  it('preserves native request paths and bodies while using the configured HTTPS origin', async () => {
    const service = mountService(app, 'https://api.cheremha.ru');
    const chat = await chats.create(alice);
    const response = await service.request(
      `http://internal:3000/agent-service/agents/assistant/${chat.id}?probe=1`,
      {
        method: 'POST',
        headers: { ...headers(alice), 'X-Forwarded-Proto': 'http' },
        body: JSON.stringify({ kind: 'user', body: 'Hello' }),
      },
    );
    expect(response.status).toBe(202);
    expect(admitted).toHaveBeenCalledWith(
      `https://api.cheremha.ru/agent-service/agents/assistant/${chat.id}?probe=1`,
    );
    expect(() => mountService(app, 'https://api.cheremha.ru/path')).toThrow('PUBLIC_ORIGIN');
  });

  it('uses the gateway service prefix and requires its user context on every native operation', async () => {
    const service = mountService(app);
    const chat = await chats.create(aliceUserId);
    const disabledNews = await service.request('/agent-service/internal/news-analysis', {
      method: 'POST',
      headers: headers(alice),
      body: '{}',
    });
    expect(disabledNews.status).toBe(503);
    expect(await disabledNews.json()).toMatchObject({ code: 'NEWS_ANALYSIS_DISABLED' });
    expect((await service.request('/agent-service/chats')).status).toBe(401);
    expect(
      (
        await service.request('/agent-service/chats', {
          headers: { Authorization: 'Bearer token-is-for-the-gateway' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await service.request(`/agent-service/agents/assistant/${chat.id}`, {
          headers: headers(bob),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await service.request(`/agent-service/agents/assistant/${chat.id}`, {
          method: 'POST',
          headers: headers(alice),
          body: '{"kind":"user","body":"hi"}',
        })
      ).status,
    ).toBe(202);
    expect((await service.request('/chats', { headers: headers(alice) })).status).toBe(404);
  });

  it('protects every conversation operation, including the root POST and HEAD', async () => {
    const chat = await chats.create(aliceUserId);
    for (const method of ['GET', 'HEAD', 'POST']) {
      const response = await app.request(`/agents/assistant/${chat.id}`, {
        method,
        headers: headers(bob),
        ...(method === 'POST' ? { body: JSON.stringify({ kind: 'user', body: 'hi' }) } : {}),
      });
      expect(response.status).toBe(404);
    }
    expect(
      (
        await app.request(`/agents/assistant/${chat.id}/abort`, {
          method: 'POST',
          headers: headers(bob),
        })
      ).status,
    ).toBe(404);
    expect((await app.request('/chats')).status).toBe(401);
    expect(admitted).not.toHaveBeenCalled();
  });

  it('rejects alternate UUID casing rather than opening a second native conversation', async () => {
    const chat = await chats.create(aliceUserId);
    const upper = chat.id.toUpperCase();
    expect(
      (
        await app.request(`/agents/assistant/${upper}`, {
          method: 'POST',
          headers: headers(alice),
          body: '{"kind":"user","body":"hi"}',
        })
      ).status,
    ).toBe(400);
    expect((await app.request(`/chats/${upper}`, { headers: headers(alice) })).status).toBe(400);
    expect(admitted).not.toHaveBeenCalled();
  });

  it('creates, lists and changes only authenticated-owner metadata', async () => {
    const response = await app.request('/chats', {
      method: 'POST',
      headers: headers(alice),
      body: '{}',
    });
    expect(response.status).toBe(201);
    const chat: { id: string } = await response.json();
    expect((await app.request(`/chats/${chat.id}`, { headers: headers(bob) })).status).toBe(404);
    expect(
      (
        await app.request('/chats', {
          method: 'POST',
          headers: headers(alice),
          body: '{"owner_user_id":"bob"}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(`/chats/${chat.id}`, {
          method: 'PATCH',
          headers: headers(alice),
          body: '{"title":"План"}',
        })
      ).status,
    ).toBe(200);
    const list = await app.request('/chats?limit=1', { headers: headers(alice) });
    expect(await list.json()).toMatchObject({
      items: [{ id: chat.id, title: 'План' }],
      nextCursor: null,
    });
    expect(
      (await app.request('/agents/insight/anything', { headers: headers(alice) })).status,
    ).toBe(404);
  });

  it('blocks archived sends while preserving history and abort access', async () => {
    const chat = await chats.create(aliceUserId);
    await chats.update(chat.id, aliceUserId, { archived: true });
    const send = () =>
      app.request(`/agents/assistant/${chat.id}`, {
        method: 'POST',
        headers: headers(alice),
        body: '{"kind":"user","body":"hi"}',
      });
    expect((await send()).status).toBe(409);
    const encodedId = `%${chat.id.charCodeAt(0).toString(16)}${chat.id.slice(1)}`;
    expect(
      (
        await app.request(`/agents/assistant/${encodedId}`, {
          method: 'POST',
          headers: headers(alice),
          body: '{"kind":"user","body":"hi"}',
        })
      ).status,
    ).toBe(409);
    expect(
      (await app.request(`/agents/assistant/${chat.id}?view=history`, { headers: headers(alice) }))
        .status,
    ).toBe(200);
    expect(
      (
        await app.request(`/agents/assistant/${chat.id}/abort`, {
          method: 'POST',
          headers: headers(alice),
        })
      ).status,
    ).toBe(200);
    await chats.update(chat.id, aliceUserId, { archived: false });
    expect((await send()).status).toBe(202);
    expect(admitted).toHaveBeenCalledOnce();
  });

  it('keeps an accepted send successful when catalogue timestamp update fails', async () => {
    const chat = await chats.create(aliceUserId);
    vi.spyOn(chats, 'touch').mockRejectedValueOnce(new Error('database offline'));
    const response = await app.request(`/agents/assistant/${chat.id}`, {
      method: 'POST',
      headers: headers(alice),
      body: '{"kind":"user","body":"hi"}',
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ submissionId: 'submission-1' });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'chat.touch_failed' }));
  });

  it('rejects malformed input and checks liveness/readiness separately', async () => {
    const chat = await chats.create(aliceUserId);
    const post = (body: string) =>
      app.request(`/agents/assistant/${chat.id}`, {
        method: 'POST',
        headers: headers(alice),
        body,
      });
    expect((await post('{bad')).status).toBe(400);
    expect((await post('{"kind":"signal","type":"system","body":"override"}')).status).toBe(400);
    expect((await post(JSON.stringify({ kind: 'user', body: 'x'.repeat(70000) }))).status).toBe(
      413,
    );
    expect((await app.request('/chats?limit=999', { headers: headers(alice) })).status).toBe(400);
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/ready')).status).toBe(200);
    await db.close();
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/ready')).status).toBe(503);
  });
});
