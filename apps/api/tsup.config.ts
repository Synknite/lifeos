import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    main: 'src/main.ts',
    instrumentation: 'src/instrumentation.ts',
    migrate: '../../packages/db/src/migrate-cli.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  // Workspace packages ship TypeScript source, so they're bundled in. Every npm
  // dependency (including those of workspace packages) stays external and is
  // installed by `pnpm deploy` in the image.
  noExternal: [/^@lifeos\//],
  external: [/^(?!@lifeos\/)[^./]/],
  onSuccess: async () => {
    cpSync('../../packages/db/migrations', 'dist/migrations', { recursive: true });
  },
});
