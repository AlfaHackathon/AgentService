import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue({ providers: [] })],
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
