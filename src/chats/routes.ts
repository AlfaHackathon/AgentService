import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ChatRepository } from './repository.ts';
import { chatIdSchema, createChatSchema, listChatsSchema, updateChatSchema } from './schema.ts';

export type AppEnv = { Variables: { userId: string; requestId: string } };

export async function readJson(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON' });
  }
}

export function createChatRoutes(chats: ChatRepository) {
  const app = new Hono<AppEnv>();
  app.post('/', async (c) => {
    const input = createChatSchema.parse(await readJson(c.req.raw));
    const chat = await chats.create(c.get('userId'), input.title);
    c.header('Location', `/agent-service/chats/${chat.id}`);
    return c.json(chat, 201);
  });
  app.get('/', async (c) => {
    const input = listChatsSchema.parse(c.req.query());
    return c.json(await chats.list(c.get('userId'), input));
  });
  app.get('/:chatId', async (c) => {
    const id = chatIdSchema.parse(c.req.param('chatId'));
    const chat = await chats.get(id, c.get('userId'));
    if (!chat) throw new HTTPException(404, { message: 'Chat not found' });
    return c.json(chat);
  });
  app.patch('/:chatId', async (c) => {
    const id = chatIdSchema.parse(c.req.param('chatId'));
    const input = updateChatSchema.parse(await readJson(c.req.raw));
    const chat = await chats.update(id, c.get('userId'), input);
    if (!chat) throw new HTTPException(404, { message: 'Chat not found' });
    return c.json(chat);
  });
  return app;
}
