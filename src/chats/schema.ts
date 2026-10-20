import { z } from 'zod';

export const chatIdSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase(), 'Use lowercase chat IDs');
const title = z.string().trim().min(1).max(200);
export const createChatSchema = z.strictObject({ title: title.optional() });
export const updateChatSchema = z
  .strictObject({ title: title.optional(), archived: z.boolean().optional() })
  .refine((value) => value.title !== undefined || value.archived !== undefined, 'Empty update');

export const listChatsSchema = z.strictObject({
  archive: z.enum(['active', 'archived', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
});

const cursorSchema = z.strictObject({
  version: z.literal(1),
  archive: z.enum(['active', 'archived', 'all']),
  updatedAt: z.iso.datetime(),
  id: chatIdSchema,
});

export type ChatListOptions = z.infer<typeof listChatsSchema>;
export type ChatUpdate = z.infer<typeof updateChatSchema>;

export class InvalidCursorError extends Error {}

export function decodeCursor(cursor: string, archive: ChatListOptions['archive']) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid encoding');
    const decoded = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (decoded.archive !== archive) throw new Error('Archive filter changed');
    return decoded;
  } catch {
    throw new InvalidCursorError('Invalid cursor');
  }
}

export function encodeCursor(value: z.infer<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
