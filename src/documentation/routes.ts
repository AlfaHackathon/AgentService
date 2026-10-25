import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Hono } from 'hono';
import { agentOpenApi } from './openapi.ts';

const require = createRequire(import.meta.url);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>AgentService API</title><link rel="stylesheet" href="./swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="./swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:'./v1/swagger.json',dom_id:'#swagger-ui',persistAuthorization:false,validatorUrl:null,queryConfigEnabled:false});</script></body></html>`;

export function documentationRoutes() {
  const app = new Hono();
  app.get('/', (c) => c.redirect(`${c.req.path.replace(/\/$/, '')}/index.html`));
  app.get('/index.html', (c) => c.html(html));
  app.get('/v1/swagger.json', (c) => c.json(agentOpenApi()));
  for (const [file, contentType] of [
    ['swagger-ui.css', 'text/css; charset=utf-8'],
    ['swagger-ui-bundle.js', 'application/javascript; charset=utf-8'],
  ]) {
    if (!file || !contentType) continue;
    const asset = readFileSync(require.resolve(`swagger-ui-dist/${file}`), 'utf8');
    app.get(`/${file}`, (c) => {
      return c.body(asset, 200, { 'Content-Type': contentType });
    });
  }
  return app;
}
