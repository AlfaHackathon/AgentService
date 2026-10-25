import SwaggerParser from '@apidevtools/swagger-parser';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApplication, mountService } from '../src/application.ts';
import { ChatRepository } from '../src/chats/repository.ts';
import { agentOpenApi } from '../src/documentation/openapi.ts';

// Documentation must not resolve dependencies, inspect data, or invoke a model.
const sql = {
  query: async () => {
    throw new Error('Documentation accessed storage');
  },
};
function service(enabled: boolean) {
  return mountService(
    createApplication({
      chats: new ChatRepository(sql),
      agentRouter: new Hono(),
      ready: async () => {},
      swaggerEnabled: enabled,
      log: () => {},
    }),
  );
}

describe('opt-in Swagger/OpenAPI', () => {
  it('validates the document and keeps public/internal security separate', async () => {
    const document = agentOpenApi();
    await SwaggerParser.validate(JSON.parse(JSON.stringify(document)));
    expect(document.paths['/chats'].post.security).toEqual([{ GatewayBearer: [] }]);
    expect(document.paths['/internal/news-analysis'].post.security).toEqual([
      { InternalSecret: [] },
    ]);
    const native = document.paths['/agents/assistant/{chatId}'];
    expect(native.get.responses['200'].content['text/event-stream'].schema).toEqual({
      type: 'string',
    });
    expect(native.post.responses['202']).toBeDefined();
    expect(JSON.stringify(document.components.schemas.AnalysisRequest)).not.toContain(
      'companyImportance',
    );
    expect(JSON.stringify(document.components.schemas.AnalysisReceipt)).toContain(
      'companyImportance',
    );
    const input = document.components.schemas.UserMessage;
    expect(input.additionalProperties).toBe(false);
    expect(input.properties).not.toHaveProperty('message');
    expect(input.properties).not.toHaveProperty('companyId');
    expect(input.properties).not.toHaveProperty('initialData');
    expect(document.components.securitySchemes.InternalSecret).not.toHaveProperty('example');
  });

  it('serves the spec and local UI assets without a database/model or CDN', async () => {
    const app = service(true);
    const spec = await app.request('/agent-service/swagger/v1/swagger.json');
    expect(spec.status).toBe(200);
    expect(await spec.json()).toMatchObject({ openapi: '3.1.0' });
    const ui = await app.request('/agent-service/swagger/index.html');
    expect(ui.status).toBe(200);
    const html = await ui.text();
    expect(html).toContain('persistAuthorization:false');
    expect(html).not.toContain('https://');
    for (const file of ['swagger-ui.css', 'swagger-ui-bundle.js'])
      expect((await app.request(`/agent-service/swagger/${file}`)).status).toBe(200);
    expect((await app.request('/agent-service/chats')).status).toBe(401);
    expect(
      (await app.request('/agent-service/internal/news-analysis', { method: 'POST' })).status,
    ).toBe(503);
  });

  it('does not map documentation unless explicitly enabled', async () => {
    const app = service(false);
    for (const path of ['index.html', 'v1/swagger.json', 'swagger-ui-bundle.js'])
      expect((await app.request(`/agent-service/swagger/${path}`)).status).toBe(404);
  });
});
