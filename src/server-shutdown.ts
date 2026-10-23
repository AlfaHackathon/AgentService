export async function stopService(
  stopNews: () => Promise<unknown>,
  stopServer: () => Promise<void>,
) {
  const errors: unknown[] = [];
  for (const stop of [stopNews, stopServer]) {
    try {
      await stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Agent service shutdown failed');
}
