import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface PendingAuthorization {
  state: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  clientState: string | undefined;
  scopes: string[];
  resource: string | undefined;
  expiresAt: Date;
}

export interface AuthCodeRecord {
  codeHash: string;
  identityId: number;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string | undefined;
  expiresAt: Date;
}

export type TokenKind = 'access' | 'refresh';

export interface TokenRecord {
  tokenHash: string;
  identityId: number;
  kind: TokenKind;
  clientId: string;
  scopes: string[];
  resource: string | undefined;
  expiresAt: Date;
}

export interface FreshBooksCredentials {
  identityId: number;
  email: string;
  businessId: number;
  accountId: string;
  businessName: string | undefined;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  redirectUri: string;
}

export interface Store {
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  saveClient(client: OAuthClientInformationFull): Promise<void>;

  savePendingAuthorization(pending: PendingAuthorization): Promise<void>;
  takePendingAuthorization(state: string): Promise<PendingAuthorization | undefined>;

  saveAuthCode(code: AuthCodeRecord): Promise<void>;
  getAuthCode(codeHash: string): Promise<AuthCodeRecord | undefined>;
  takeAuthCode(codeHash: string, clientId: string): Promise<AuthCodeRecord | undefined>;

  saveToken(token: TokenRecord): Promise<void>;
  getToken(tokenHash: string): Promise<TokenRecord | undefined>;
  takeToken(tokenHash: string, kind: TokenKind, clientId: string): Promise<TokenRecord | undefined>;
  deleteToken(tokenHash: string): Promise<void>;

  getCredentials(identityId: number): Promise<FreshBooksCredentials | undefined>;
  saveCredentials(credentials: FreshBooksCredentials): Promise<void>;
  withCredentialsLock<T>(
    identityId: number,
    fn: (current: FreshBooksCredentials | undefined) => Promise<{ save?: FreshBooksCredentials; result: T }>,
  ): Promise<T>;
  countCredentials(): Promise<number>;

  ping(): Promise<void>;
}
