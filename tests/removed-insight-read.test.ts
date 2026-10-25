import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createApplication, mountService } from '../src/application.ts';
import { ChatRepository } from '../src/chats/repository.ts';
import { agentOpenApi } from '../src/documentation/openapi.ts';
import { aliceUserId } from './helpers/identity.ts';

describe('removed Agent insight read facade', () => {
  const paths = [
    '/insights',
    '/insights?kind=general&limit=5',
    '/insights/personal/saved-question',
    '/insights/general/opaque-result',
    '/insights/personal/saved-question/history?limit=10',
  ];
  for (const [identity, headers] of [
    ['anonymous', {}],
    ['Bearer', { Authorization: 'Bearer for-gateway-only' }],
    ['trusted user', { 'X-User-Id': aliceUserId }],
    ['malformed user', { 'X-User-Id': 'not-a-user-id' }],
  ] as const) {
    it.each(paths)(
      `returns 404 without redirect or storage access for ${identity}: %s`,
      async (path) => {
        const query = vi.fn(async () => {
          throw new Error('Removed route accessed storage');
        });
        const app = mountService(
          createApplication({
            chats: new ChatRepository({ query }),
            agentRouter: new Hono(),
            ready: async () => {},
            log: () => {},
          }),
        );
        for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
          const response = await app.request(`/agent-service${path}`, { method, headers });
          expect(response.status).toBe(404);
          expect(response.headers.has('location')).toBe(false);
        }
        expect(query).not.toHaveBeenCalled();
      },
    );
  }

  it('does not advertise removed routes, cards or the public-insights tag in Agent OpenAPI', () => {
    const document = agentOpenApi();
    expect(Object.keys(document.paths).some((path) => path.startsWith('/insights'))).toBe(false);
    for (const name of ['InsightCard', 'InsightFeed', 'InsightHistory'])
      expect(document.components.schemas).not.toHaveProperty(name);
    expect(document.tags.some((tag) => tag.name.startsWith('Public insights'))).toBe(false);
    expect(document.paths).toHaveProperty('/chats');
    expect(document.paths).toHaveProperty('/agents/assistant/{chatId}');
    expect(document.paths).toHaveProperty('/internal/news-analysis');
  });
});
