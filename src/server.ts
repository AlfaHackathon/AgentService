import { startFlueNodeServer } from 'virtual:flue/server';
import { stopNewsAnalysis } from './app.ts';
import { stopService } from './server-shutdown.ts';

const server = await startFlueNodeServer({ port: Number.parseInt(process.env.PORT || '3000', 10) });
let stopping: Promise<void> | undefined;
function stop(exitCode: number) {
  if (stopping) return stopping;
  const timeout = setTimeout(() => {
    console.error('Agent service shutdown timed out');
    process.exit(exitCode);
  }, 60000);
  timeout.unref();
  stopping = stopService(stopNewsAnalysis, () => server.stop()).then(
    () => process.exit(exitCode),
    () => {
      console.error('Agent service shutdown failed');
      process.exit(1);
    },
  );
  return stopping;
}
process.once('SIGINT', () => void stop(130));
process.once('SIGTERM', () => void stop(143));
process.once('disconnect', () => void stop(0));
