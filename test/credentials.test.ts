import { describe, expect, it } from 'vitest';
import { CredentialManager } from '../src/freshbooks/credentials.js';
import { FreshBooksNotConnectedError } from '../src/freshbooks/errors.js';
import { FreshBooksHttp } from '../src/freshbooks/http.js';
import type { FreshBooksCredentials } from '../src/store/types.js';
import { fakeFetch, json, type Recorded } from './support/fakeFetch.js';
import { MemoryStore } from './support/memoryStore.js';

const NOW = new Date('2026-10-01T12:00:00Z');
const app = () => ({ clientId: 'cid', clientSecret: 'secret' });

function creds(overrides: Partial<FreshBooksCredentials> = {}): FreshBooksCredentials {
  return {
    identityId: 7,
    email: 'charles@example.com',
    businessId: 100,
    accountId: 'abc',
    businessName: 'Biz',
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    accessTokenExpiresAt: new Date(NOW.getTime() - 1000),
    redirectUri: 'https://fb.example.com/oauth/callback',
    ...overrides,
  };
}

function rotatingTokenServer() {
  let n = 0;
  const valid = new Set(['refresh-0']);
  return (req: Recorded) => {
    if (req.url.pathname !== '/auth/oauth/token') return undefined;
    if (req.body.grant_type !== 'refresh_token' || !valid.has(req.body.refresh_token)) {
      return json({ error: 'invalid_grant', error_description: 'The provided authorization grant is invalid' }, 400);
    }
    valid.clear();
    n += 1;
    valid.add(`refresh-${n}`);
    return json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 43200, created_at: NOW.getTime() / 1000, token_type: 'Bearer' });
  };
}

describe('CredentialManager', () => {
  it('returns stored credentials while the access token is fresh', async () => {
    const store = new MemoryStore();
    await store.saveCredentials(creds({ accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000) }));
    const { fetch, calls } = fakeFetch([]);
    const manager = new CredentialManager({ store, app, fetchImpl: fetch, now: () => NOW });
    expect((await manager.current(7)).accessToken).toBe('access-0');
    expect(calls).toHaveLength(0);
  });

  it('refreshes an expiring token and persists the rotated refresh token', async () => {
    const store = new MemoryStore();
    await store.saveCredentials(creds());
    const { fetch, calls } = fakeFetch([rotatingTokenServer()]);
    const manager = new CredentialManager({ store, app, fetchImpl: fetch, now: () => NOW });

    const result = await manager.current(7);
    expect(result.accessToken).toBe('access-1');
    expect(store.credentials?.refreshToken).toBe('refresh-1');
    expect(store.credentials?.accessTokenExpiresAt.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(calls[0]!.body).toMatchObject({
      grant_type: 'refresh_token',
      client_id: 'cid',
      client_secret: 'secret',
      refresh_token: 'refresh-0',
      redirect_uri: 'https://fb.example.com/oauth/callback',
    });
  });

  it('performs a single refresh for concurrent callers', async () => {
    const store = new MemoryStore();
    await store.saveCredentials(creds());
    const { fetch, calls } = fakeFetch([rotatingTokenServer()]);
    const manager = new CredentialManager({ store, app, fetchImpl: fetch, now: () => NOW });

    const results = await Promise.all([manager.current(7), manager.current(7), manager.current(7)]);
    expect(results.map((r) => r.accessToken)).toEqual(['access-1', 'access-1', 'access-1']);
    expect(calls.filter((c) => c.url.pathname === '/auth/oauth/token')).toHaveLength(1);
  });

  it('does not refresh again when another process already rotated the token', async () => {
    const store = new MemoryStore();
    await store.saveCredentials(creds({ accessToken: 'access-9', refreshToken: 'refresh-9', accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000) }));
    const { fetch, calls } = fakeFetch([rotatingTokenServer()]);
    const manager = new CredentialManager({ store, app, fetchImpl: fetch, now: () => NOW });
    const result = await manager.refresh(7, 'access-0');
    expect(result.accessToken).toBe('access-9');
    expect(calls).toHaveLength(0);
  });

  it('uses the newest refresh token on each subsequent refresh', async () => {
    const store = new MemoryStore();
    await store.saveCredentials(creds());
    const { fetch, calls } = fakeFetch([rotatingTokenServer()]);
    const manager = new CredentialManager({ store, app, fetchImpl: fetch, now: () => NOW });
    const first = await manager.current(7);
    const second = await manager.refresh(7, first.accessToken);
    expect(second.accessToken).toBe('access-2');
    expect(calls.map((c) => c.body.refresh_token)).toEqual(['refresh-0', 'refresh-1']);
    expect(store.credentials?.refreshToken).toBe('refresh-2');
  });

  it('reports a reconnect error when FreshBooks rejects the refresh token, keeping stored credentials', async () => {
    const store = new MemoryStore();
    await store.saveCredentials(creds({ refreshToken: 'revoked' }));
    const { fetch } = fakeFetch([rotatingTokenServer()]);
    const manager = new CredentialManager({ store, app, fetchImpl: fetch, now: () => NOW });
    await expect(manager.current(7)).rejects.toBeInstanceOf(FreshBooksNotConnectedError);
    expect(store.credentials?.refreshToken).toBe('revoked');
  });

  it('errors clearly when nothing is connected', async () => {
    const manager = new CredentialManager({ store: new MemoryStore(), app, now: () => NOW });
    await expect(manager.current(7)).rejects.toThrow(/not connected/);
  });
});

describe('FreshBooksHttp', () => {
  it('refreshes and retries once on a 401', async () => {
    const store = new MemoryStore();
    await store.saveCredentials(creds({ accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000) }));
    const { fetch, calls } = fakeFetch([
      rotatingTokenServer(),
      (req) => {
        if (!req.url.pathname.startsWith('/timetracking')) return undefined;
        if (req.headers.authorization !== 'Bearer access-1') return json({ error: 'unauthenticated' }, 401);
        return json({ time_entries: [], meta: { page: 1, pages: 1, per_page: 15, total: 0 } });
      },
    ]);
    const http = new FreshBooksHttp(new CredentialManager({ store, app, fetchImpl: fetch, now: () => NOW }), 7, fetch);
    const res = await http.request<{ time_entries: unknown[] }>('GET', '/timetracking/business/100/time_entries');
    expect(res.time_entries).toEqual([]);
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/timetracking/business/100/time_entries',
      '/auth/oauth/token',
      '/timetracking/business/100/time_entries',
    ]);
  });

  it('surfaces FreshBooks error messages', async () => {
    const store = new MemoryStore();
    await store.saveCredentials(creds({ accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000) }));
    const { fetch } = fakeFetch([() => json({ errors: [{ errno: 1012, field: 'client_id', message: 'Client is required' }] }, 422)]);
    const http = new FreshBooksHttp(new CredentialManager({ store, app, fetchImpl: fetch, now: () => NOW }), 7, fetch);
    await expect(http.request('POST', '/timetracking/business/100/time_entries', { body: {} })).rejects.toThrow(/client_id: Client is required/);
  });
});
