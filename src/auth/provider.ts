import type { Request, Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { authConfigProblems, type Config } from '../config.js';
import { authorizeUrl, emailAllowed } from '../freshbooks/oauth.js';
import { baseUrlFor, freshbooksRedirectUri } from '../http/baseUrl.js';
import type { Store } from '../store/types.js';
import { hashToken, randomToken } from './tokens.js';

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
export const AUTH_CODE_TTL_SECONDS = 10 * 60;
export const PENDING_TTL_SECONDS = 15 * 60;

export interface ProviderDeps {
  store: Store;
  config: Config;
  now?: () => Date;
}

export class FreshBooksAuthProvider implements OAuthServerProvider {
  private readonly now: () => Date;

  constructor(private readonly deps: ProviderDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const { store } = this.deps;
    return {
      getClient: (clientId) => store.getClient(clientId),
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        await store.saveClient(full);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const { config, store } = this.deps;
    const problems = authConfigProblems(config);
    if (problems.length || !config.freshbooks) {
      throw new ServerError(`Server not configured: ${problems.join('; ')}`);
    }
    const state = randomToken();
    await store.savePendingAuthorization({
      state,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      clientState: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      expiresAt: this.expiresIn(PENDING_TTL_SECONDS),
    });
    const base = baseUrlFor(res.req as Request, config.publicUrl);
    res.redirect(302, authorizeUrl({ clientId: config.freshbooks.clientId, redirectUri: freshbooksRedirectUri(base) }, state));
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = await this.deps.store.getAuthCode(hashToken(authorizationCode));
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const record = await this.deps.store.takeAuthCode(hashToken(authorizationCode));
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    return this.issueTokens(client.client_id, record.scopes, record.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const record = await this.deps.store.takeToken(hashToken(refreshToken), 'refresh');
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired refresh token');
    const granted = scopes?.length ? scopes.filter((s) => record.scopes.includes(s)) : record.scopes;
    return this.issueTokens(client.client_id, granted, record.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.deps.store.getToken(hashToken(token));
    if (!record || record.kind !== 'access') throw new InvalidTokenError('Invalid or expired access token');
    const creds = await this.deps.store.getCredentials();
    if (!creds || !emailAllowed(creds.email, this.deps.config.allowedEmail)) {
      throw new InvalidTokenError('The connected FreshBooks account is no longer allowed; sign in again');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt.getTime() / 1000),
      resource: record.resource ? new URL(record.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.deps.store.deleteToken(hashToken(request.token));
  }

  async issueAuthorizationCode(pending: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    resource: string | undefined;
  }): Promise<string> {
    const code = randomToken();
    await this.deps.store.saveAuthCode({
      codeHash: hashToken(code),
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
      expiresAt: this.expiresIn(AUTH_CODE_TTL_SECONDS),
    });
    return code;
  }

  private async issueTokens(clientId: string, scopes: string[], resource: string | undefined): Promise<OAuthTokens> {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    await this.deps.store.saveToken({
      tokenHash: hashToken(accessToken),
      kind: 'access',
      clientId,
      scopes,
      resource,
      expiresAt: this.expiresIn(ACCESS_TOKEN_TTL_SECONDS),
    });
    await this.deps.store.saveToken({
      tokenHash: hashToken(refreshToken),
      kind: 'refresh',
      clientId,
      scopes,
      resource,
      expiresAt: this.expiresIn(REFRESH_TOKEN_TTL_SECONDS),
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      ...(scopes.length ? { scope: scopes.join(' ') } : {}),
    };
  }

  private expiresIn(seconds: number): Date {
    return new Date(this.now().getTime() + seconds * 1000);
  }
}
