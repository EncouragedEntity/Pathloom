import { defineConfig } from 'vitest/config';

// `vite` (dev) serves the harness in ./dev; `vite build` builds the ESM library; vitest runs ./test.
export default defineConfig(({ command }) => ({
  ...(command === 'serve'
    ? { root: 'dev', server: { port: 5174, open: false } }
    : {
        build: {
          lib: { entry: 'src/index.ts', formats: ['es' as const], fileName: 'index' },
          rollupOptions: { external: ['roughjs', 'perfect-freehand', 'rbush'] },
        },
      }),
  test: { root: '.', dir: 'test', include: ['**/*.test.ts'] },
}));
