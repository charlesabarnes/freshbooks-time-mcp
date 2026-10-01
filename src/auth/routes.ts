import express, { type RequestHandler, type Router } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { authConfigProblems, type Config } from '../config.js';
import { baseUrlFor, FRESHBOOKS_CALLBACK_PATH } from '../http/baseUrl.js';
import type { Store } from '../store/types.js';
import { freshbooksCallback } from './callback.js';
import { FreshBooksAuthProvider } from './provider.js';

export const MCP_PATH = '/mcp';
export const RESOURCE_NAME = 'FreshBooks Time';

const MAX_CACHED_ORIGINS = 16;

export interface AuthDeps {
  store: Store;
  config: Config;
  fetchImpl: typeof fetch;
  now?: () => Date;
}

const AUTH_PATHS = [
  '/authorize',
  '/token',
  '/register',
  '/revoke',
  '/.well-known/oauth-authorization-server',
  `/.well-known/oauth-protected-resource${MCP_PATH}`,
];

const rateLimit = { validate: { trustProxy: false, xForwardedForHeader: false, creationStack: false } } as const;

export function createAuth(deps: AuthDeps): { router: Router; bearer: RequestHandler; provider: FreshBooksAuthProvider } {
  const provider = new FreshBooksAuthProvider(deps);
  const routers = new Map<string, RequestHandler>();
  const router = express.Router();

  const authRouterFor = (base: string): RequestHandler => {
    let handler = routers.get(base);
    if (!handler) {
      handler = mcpAuthRouter({
        provider,
        issuerUrl: new URL(base),
        resourceServerUrl: new URL(MCP_PATH, base),
        resourceName: RESOURCE_NAME,
        authorizationOptions: { rateLimit },
        tokenOptions: { rateLimit },
        revocationOptions: { rateLimit },
        clientRegistrationOptions: { rateLimit, clientSecretExpirySeconds: 0 },
      });
      if (routers.size >= MAX_CACHED_ORIGINS) routers.delete(routers.keys().next().value!);
      routers.set(base, handler);
    }
    return handler;
  };

  router.get(FRESHBOOKS_CALLBACK_PATH, freshbooksCallback({ ...deps, provider }));

  router.use('/authorize', (_req, res, next) => {
    const problems = authConfigProblems(deps.config);
    if (!problems.length) return next();
    res.status(503).json({
      error: 'server_error',
      error_description: `FreshBooks sign-in is not configured yet: ${problems.join('; ')}.`,
    });
  });

  router.get('/.well-known/oauth-protected-resource', (req, res) => {
    const base = baseUrlFor(req, deps.config.publicUrl);
    res.json({
      resource: new URL(MCP_PATH, base).href,
      authorization_servers: [new URL(base).href],
      resource_name: RESOURCE_NAME,
    });
  });

  router.use((req, res, next) => {
    if (!AUTH_PATHS.includes(req.path)) return next();
    const base = baseUrlFor(req, deps.config.publicUrl);
    let handler: RequestHandler;
    try {
      handler = authRouterFor(base);
    } catch (error) {
      res.status(500).json({ error: 'server_error', error_description: (error as Error).message });
      return;
    }
    handler(req, res, next);
  });

  const bearer: RequestHandler = (req, res, next) => {
    const base = baseUrlFor(req, deps.config.publicUrl);
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(MCP_PATH, base));
    return requireBearerAuth({ verifier: provider, resourceMetadataUrl })(req, res, next);
  };

  return { router, bearer, provider };
}
