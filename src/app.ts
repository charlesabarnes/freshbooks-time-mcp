import express, { type Express } from 'express';
import { createAuth, MCP_PATH } from './auth/routes.js';
import { authConfigProblems, type Config } from './config.js';
import { CredentialManager } from './freshbooks/credentials.js';
import { baseUrlFor, freshbooksRedirectUri } from './http/baseUrl.js';
import { mcpHandler, methodNotAllowed } from './mcp/server.js';
import type { Store } from './store/types.js';

export interface AppDeps {
  config: Config;
  store: Store;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function createApp(deps: AppDeps): Express {
  const { config, store } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  const credentials = new CredentialManager({
    store,
    fetchImpl,
    now: deps.now,
    app: () => config.freshbooks,
  });

  app.get('/healthz', async (_req, res) => {
    try {
      await store.ping();
    } catch {
      res.status(503).json({ ok: false, database: false });
      return;
    }
    const connectedUsers = await store.countCredentials().catch(() => null);
    const problems = authConfigProblems(config);
    res.json({ ok: true, database: true, auth_configured: problems.length === 0, config_problems: problems, connected_users: connectedUsers });
  });

  app.get('/', (req, res) => {
    const base = baseUrlFor(req, config.publicUrl);
    res
      .type('text/plain')
      .send(
        `FreshBooks Time MCP server\n\nMCP endpoint: ${base}${MCP_PATH}\nFreshBooks redirect URI: ${freshbooksRedirectUri(base)}\n`,
      );
  });

  const auth = createAuth({ store, config, fetchImpl, now: deps.now });
  app.use(auth.router);

  const handler = mcpHandler({ credentials, fetchImpl, defaultTimeZone: config.defaultTimeZone, now: deps.now });
  app.post(MCP_PATH, auth.bearer, express.json({ limit: '1mb' }), handler);
  app.all(MCP_PATH, auth.bearer, methodNotAllowed);

  return app;
}
