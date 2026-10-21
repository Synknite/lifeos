import { expectedMigrationCount, runMigrations } from './migrate.js';

// `pnpm db:migrate` locally, `node dist/migrate.js` in the API image (Helm hook Job).
const url = process.env.DATABASE_URL ?? 'postgres://lifeos:lifeos@localhost:5432/lifeos';
const started = Date.now();
try {
  await runMigrations(url);
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'migrations applied',
      count: expectedMigrationCount(),
      ms: Date.now() - started,
    }),
  );
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: 'migration failed', err: String(err) }));
  process.exit(1);
}
