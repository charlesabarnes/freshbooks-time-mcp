import type { FreshBooksCredentials, Store } from '../store/types.js';
import { FreshBooksApiError, FreshBooksNotConnectedError } from './errors.js';
import { refreshTokens } from './oauth.js';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface CredentialManagerOptions {
  store: Store;
  app: () => { clientId: string; clientSecret: string } | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class CredentialManager {
  private inflight: Promise<FreshBooksCredentials> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: CredentialManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async current(): Promise<FreshBooksCredentials> {
    const creds = await this.options.store.getCredentials();
    if (!creds) throw new FreshBooksNotConnectedError();
    if (this.isFresh(creds)) return creds;
    return this.refresh(creds.accessToken);
  }

  refresh(staleAccessToken: string): Promise<FreshBooksCredentials> {
    if (!this.inflight) {
      this.inflight = this.doRefresh(staleAccessToken).finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private isFresh(creds: FreshBooksCredentials): boolean {
    return creds.accessTokenExpiresAt.getTime() - REFRESH_MARGIN_MS > this.now().getTime();
  }

  private doRefresh(staleAccessToken: string): Promise<FreshBooksCredentials> {
    return this.options.store.withCredentialsLock(async (current) => {
      if (!current) throw new FreshBooksNotConnectedError();
      if (current.accessToken !== staleAccessToken && this.isFresh(current)) return { result: current };
      const app = this.options.app();
      if (!app) throw new Error('FreshBooks OAuth is not configured (FRESHBOOKS_CLIENT_ID / FRESHBOOKS_CLIENT_SECRET)');
      let tokens;
      try {
        tokens = await refreshTokens(this.fetchImpl, { ...app, redirectUri: current.redirectUri }, current.refreshToken, this.now);
      } catch (error) {
        if (error instanceof FreshBooksApiError && error.status >= 400 && error.status < 500) {
          throw new FreshBooksNotConnectedError(
            'FreshBooks rejected the stored refresh token. Disconnect and reconnect this MCP server to sign in again.',
          );
        }
        throw error;
      }
      const next: FreshBooksCredentials = {
        ...current,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: tokens.expiresAt,
      };
      return { save: next, result: next };
    });
  }
}
