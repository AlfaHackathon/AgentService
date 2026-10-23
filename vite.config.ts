import { fileURLToPath } from 'node:url';
import { flue } from '@flue/vite';
import { defineConfig, normalizePath } from 'vite';

export default defineConfig({
  plugins: [
    {
      name: 'agent-service-production-entry',
      apply: 'build',
      buildStart() {
        this.emitFile({
          type: 'chunk',
          id: fileURLToPath(new URL('./src/server.ts', import.meta.url)),
          fileName: 'service.mjs',
        });
      },
    },
    {
      name: 'canonical-windows-module-paths',
      enforce: 'pre',
      // Flue scans absolute Windows paths; app imports resolve to POSIX paths.
      // Both must address the same function object for init()/dispatch().
      resolveId: {
        order: 'pre',
        handler(source) {
          return /^[a-z]:[\\/]/i.test(source) ? normalizePath(source) : null;
        },
      },
    },
    flue({ providers: [] }),
  ],
  build: {
    rolldownOptions: {
      onwarn(warning, warn) {
        // Flue consumes this directive before bundling; it need not survive in JS.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use agent'))
          return;
        warn(warning);
      },
    },
  },
});
