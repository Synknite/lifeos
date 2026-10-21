import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', instrumentation: 'src/instrumentation.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  noExternal: [/^@lifeos\//],
  external: [/^(?!@lifeos\/)[^./]/],
  // Readiness compares applied migrations with the ones this build expects.
  onSuccess: async () => {
    cpSync('../../packages/db/migrations', 'dist/migrations', { recursive: true });
  },
});
