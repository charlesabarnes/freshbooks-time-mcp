import pg from 'pg';
import { createApp } from './app.js';
import { loadConfig, authConfigProblems } from './config.js';
import { migrate, purgeExpired } from './db/migrate.js';
import { PgStore } from './db/pgStore.js';
import { assertTimeZone } from './time/tz.js';

async function connectWithRetry(pool: pg.Pool, attempts = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await migrate(pool);
      return;
    } catch (error) {
      if (i >= attempts) throw error;
      console.warn(`Database not ready (attempt ${i}/${attempts}): ${(error as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertTimeZone(config.defaultTimeZone);
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
  pool.on('error', (error) => console.error('Postgres pool error', error));
  await connectWithRetry(pool);
  setInterval(() => purgeExpired(pool).catch((e) => console.error('Purge failed', e)), 60 * 60 * 1000).unref();

  const app = createApp({ config, store: new PgStore(pool) });
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`freshbooks-time-mcp listening on 0.0.0.0:${config.port}`);
    const problems = authConfigProblems(config);
    if (problems.length) console.warn(`Sign-in disabled until configured: ${problems.join('; ')}`);
  });

  const shutdown = () => {
    server.close(() => void pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
