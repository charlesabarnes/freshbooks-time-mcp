import type { RequestHandler } from 'express';
import { emailAllowed, type Config } from '../config.js';
import { exchangeCode, fetchIdentity, pickBusiness } from '../freshbooks/oauth.js';
import { baseUrlFor, freshbooksRedirectUri } from '../http/baseUrl.js';
import type { Store } from '../store/types.js';
import type { FreshBooksAuthProvider } from './provider.js';

export interface CallbackDeps {
  store: Store;
  config: Config;
  provider: FreshBooksAuthProvider;
  fetchImpl: typeof fetch;
  now?: () => Date;
}

function redirectWith(target: string, params: Record<string, string | undefined>): string {
  const url = new URL(target);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}

export function freshbooksCallback(deps: CallbackDeps): RequestHandler {
  const { store, config, provider, fetchImpl } = deps;
  const now = deps.now ?? (() => new Date());
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const param = (name: string) => (typeof req.query[name] === 'string' ? (req.query[name] as string) : undefined);
    const state = param('state');
    const pending = state ? await store.takePendingAuthorization(state) : undefined;
    if (!pending) {
      res.status(400).type('text/plain').send('Unknown or expired sign-in attempt. Start the connection again from your MCP client.');
      return;
    }
    const fail = (error: string, description: string) =>
      res.redirect(302, redirectWith(pending.redirectUri, { error, error_description: description, state: pending.clientState }));

    const fbError = param('error');
    if (fbError) return fail('access_denied', `FreshBooks sign-in failed: ${param('error_description') ?? fbError}`);
    const code = param('code');
    if (!code) return fail('invalid_request', 'FreshBooks did not return an authorization code');
    if (!config.freshbooks) return fail('server_error', 'FreshBooks OAuth is not configured on this server');

    try {
      const app = { ...config.freshbooks, redirectUri: freshbooksRedirectUri(baseUrlFor(req, config.publicUrl)) };
      const tokens = await exchangeCode(fetchImpl, app, code, now);
      const identity = await fetchIdentity(fetchImpl, tokens.accessToken);
      if (!emailAllowed(identity.email, config.allowlist)) {
        console.warn(`Refused FreshBooks sign-in for identity ${identity.id}`);
        return fail('access_denied', 'This FreshBooks account is not allowed to use this server');
      }
      const business = pickBusiness(identity, config.businessIdOverride);
      const account = {
        identityId: identity.id,
        email: identity.email,
        businessId: Number(business.id),
        accountId: String(business.account_id),
        businessName: business.name,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: tokens.expiresAt,
        redirectUri: app.redirectUri,
      };
      await store.withCredentialsLock(identity.id, async () => ({ save: account, result: undefined }));
      const ourCode = await provider.issueAuthorizationCode(identity.id, pending);
      res.redirect(302, redirectWith(pending.redirectUri, { code: ourCode, state: pending.clientState }));
    } catch (error) {
      console.error('FreshBooks callback failed', error);
      fail('server_error', error instanceof Error ? error.message : 'FreshBooks sign-in failed');
    }
  };
}
