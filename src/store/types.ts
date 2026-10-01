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
  takeAuthCode(codeHash: string): Promise<AuthCodeRecord | undefined>;

  saveToken(token: TokenRecord): Promise<void>;
  getToken(tokenHash: string): Promise<TokenRecord | undefined>;
  takeToken(tokenHash: string, kind: TokenKind): Promise<TokenRecord | undefined>;
  deleteToken(tokenHash: string): Promise<void>;

  getCredentials(): Promise<FreshBooksCredentials | undefined>;
  saveCredentials(credentials: FreshBooksCredentials): Promise<void>;
  withCredentialsLock<T>(fn: (current: FreshBooksCredentials | undefined) => Promise<{ save?: FreshBooksCredentials; result: T }>): Promise<T>;

  ping(): Promise<void>;
}
