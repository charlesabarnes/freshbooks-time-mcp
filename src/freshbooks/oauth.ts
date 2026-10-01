import { FreshBooksApiError, extractErrorMessage } from './errors.js';

export const FRESHBOOKS_AUTHORIZE_URL = 'https://auth.freshbooks.com/oauth/authorize';
export const FRESHBOOKS_TOKEN_URL = 'https://api.freshbooks.com/auth/oauth/token';
export const FRESHBOOKS_ME_URL = 'https://api.freshbooks.com/auth/api/v1/users/me';

const DEFAULT_ACCESS_TOKEN_SECONDS = 12 * 3600;

export interface FreshBooksOAuthApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface FreshBooksTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface BusinessMembership {
  id?: number;
  role?: string;
  business: { id: number; name?: string; account_id: string | null };
}

export interface FreshBooksIdentity {
  id: number;
  email: string;
  business_memberships: BusinessMembership[];
}

export function authorizeUrl(app: Pick<FreshBooksOAuthApp, 'clientId' | 'redirectUri'>, state: string): string {
  const url = new URL(FRESHBOOKS_AUTHORIZE_URL);
  url.searchParams.set('client_id', app.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', app.redirectUri);
  url.searchParams.set('state', state);
  return url.href;
}

async function tokenRequest(fetchImpl: typeof fetch, body: Record<string, string>, now: () => Date): Promise<FreshBooksTokenSet> {
  const res = await fetchImpl(FRESHBOOKS_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => undefined);
  if (!res.ok || !json?.access_token || !json?.refresh_token) {
    const detail = extractErrorMessage(json) ?? res.statusText;
    throw new FreshBooksApiError(res.status, `FreshBooks token request failed (${res.status}): ${detail}`, json);
  }
  const issuedAt = typeof json.created_at === 'number' ? json.created_at * 1000 : now().getTime();
  const lifetime = typeof json.expires_in === 'number' ? json.expires_in : DEFAULT_ACCESS_TOKEN_SECONDS;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(issuedAt + lifetime * 1000),
  };
}

export function exchangeCode(
  fetchImpl: typeof fetch,
  app: FreshBooksOAuthApp,
  code: string,
  now: () => Date = () => new Date(),
): Promise<FreshBooksTokenSet> {
  return tokenRequest(
    fetchImpl,
    {
      grant_type: 'authorization_code',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: app.redirectUri,
    },
    now,
  );
}

export function refreshTokens(
  fetchImpl: typeof fetch,
  app: FreshBooksOAuthApp,
  refreshToken: string,
  now: () => Date = () => new Date(),
): Promise<FreshBooksTokenSet> {
  return tokenRequest(
    fetchImpl,
    {
      grant_type: 'refresh_token',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      refresh_token: refreshToken,
      redirect_uri: app.redirectUri,
    },
    now,
  );
}

export async function fetchIdentity(fetchImpl: typeof fetch, accessToken: string): Promise<FreshBooksIdentity> {
  const res = await fetchImpl(FRESHBOOKS_ME_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const json: any = await res.json().catch(() => undefined);
  if (!res.ok || !json?.response) {
    throw new FreshBooksApiError(res.status, `FreshBooks identity request failed (${res.status}): ${extractErrorMessage(json) ?? res.statusText}`, json);
  }
  const me = json.response;
  return {
    id: Number(me.id),
    email: String(me.email ?? ''),
    business_memberships: Array.isArray(me.business_memberships) ? me.business_memberships : [],
  };
}

export function emailAllowed(email: string | undefined, allowed: string | undefined): boolean {
  if (!allowed || !email) return false;
  return email.trim().toLowerCase() === allowed.trim().toLowerCase();
}

export function pickBusiness(identity: FreshBooksIdentity, overrideId?: number): BusinessMembership['business'] {
  const businesses = identity.business_memberships.map((m) => m.business).filter((b) => b && b.account_id);
  if (overrideId !== undefined) {
    const match = businesses.find((b) => Number(b.id) === overrideId);
    if (!match) throw new Error(`FRESHBOOKS_BUSINESS_ID ${overrideId} is not one of this FreshBooks user's businesses`);
    return match;
  }
  const first = businesses[0];
  if (!first) throw new Error('This FreshBooks user has no business memberships with an accounting account');
  return first;
}
