import { expect, it, vi } from 'vitest';
import { stopService } from '../src/server-shutdown.ts';

it('waits for pending news admission before closing the Flue server', async () => {
  let release: (() => void) | undefined;
  const news = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const server = vi.fn(async () => {});
  const work = stopService(news, server);
  expect(news).toHaveBeenCalledOnce();
  expect(server).not.toHaveBeenCalled();
  if (!release) throw new Error('Missing pending shutdown');
  release();
  await work;
  expect(server).toHaveBeenCalledOnce();
});

it('still closes the server when news shutdown fails', async () => {
  const server = vi.fn(async () => {});
  await expect(
    stopService(async () => {
      throw new Error('Unavailable');
    }, server),
  ).rejects.toThrow('shutdown failed');
  expect(server).toHaveBeenCalledOnce();
});
