import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgStore } from '../src/db/pgStore.js';
import type { FreshBooksCredentials } from '../src/store/types.js';

const url = process.env.TEST_DATABASE_URL;

const account = (identityId: number, overrides: Partial<FreshBooksCredentials> = {}): FreshBooksCredentials => ({
  identityId,
  email: `u${identityId}@example.com`,
  businessId: identityId * 10,
  accountId: `acct${identityId}`,
  businessName: undefined,
  accessToken: `a-${identityId}`,
  refreshToken: `r-${identityId}`,
  accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
  redirectUri: 'https://x/oauth/callback',
  ...overrides,
});

describe.skipIf(!url)('PgStore (TEST_DATABASE_URL)', () => {
  let pool: pg.Pool;
  let store: PgStore;
  const future = () => new Date(Date.now() + 60_000);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query('DROP TABLE IF EXISTS oauth_clients, oauth_pending_authorizations, oauth_auth_codes, oauth_tokens, freshbooks_accounts');
    await migrate(pool);
    await migrate(pool);
    store = new PgStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('round-trips clients, pending authorizations, codes and tokens', async () => {
    await store.saveClient({ client_id: 'c1', redirect_uris: ['https://cb'], client_name: 'x' });
    expect(await store.getClient('c1')).toMatchObject({ client_id: 'c1', redirect_uris: ['https://cb'] });

    await store.savePendingAuthorization({ state: 's1', clientId: 'c1', redirectUri: 'https://cb', codeChallenge: 'ch', clientState: undefined, scopes: [], resource: undefined, expiresAt: future() });
    expect(await store.takePendingAuthorization('s1')).toMatchObject({ clientId: 'c1', clientState: undefined });
    expect(await store.takePendingAuthorization('s1')).toBeUndefined();

    await store.saveAuthCode({ codeHash: 'h1', identityId: 7, clientId: 'c1', redirectUri: 'https://cb', codeChallenge: 'ch', scopes: ['a'], resource: 'https://r/mcp', expiresAt: future() });
    expect(await store.getAuthCode('h1')).toMatchObject({ identityId: 7, scopes: ['a'] });
    expect(await store.takeAuthCode('h1', 'other')).toBeUndefined();
    expect(await store.takeAuthCode('h1', 'c1')).toMatchObject({ identityId: 7 });
    expect(await store.takeAuthCode('h1', 'c1')).toBeUndefined();

    await store.saveToken({ tokenHash: 't1', identityId: 7, kind: 'refresh', clientId: 'c1', scopes: [], resource: undefined, expiresAt: future() });
    expect(await store.takeToken('t1', 'access', 'c1')).toBeUndefined();
    expect(await store.takeToken('t1', 'refresh', 'c2')).toBeUndefined();
    expect(await store.takeToken('t1', 'refresh', 'c1')).toMatchObject({ identityId: 7 });

    await store.saveToken({ tokenHash: 't2', identityId: 7, kind: 'access', clientId: 'c1', scopes: [], resource: undefined, expiresAt: new Date(Date.now() - 1000) });
    expect(await store.getToken('t2')).toBeUndefined();
  });

  it('stores accounts per identity and serializes locked updates per identity', async () => {
    await store.saveCredentials(account(1));
    await store.saveCredentials(account(2));
    await store.saveCredentials(account(1, { refreshToken: 'r-1b' }));
    expect(await store.countCredentials()).toBe(2);
    expect((await store.getCredentials(1))?.refreshToken).toBe('r-1b');
    expect((await store.getCredentials(2))?.refreshToken).toBe('r-2');

    const order: string[] = [];
    const slow = store.withCredentialsLock(1, async (current) => {
      order.push(`start1:${current?.refreshToken}`);
      await new Promise((r) => setTimeout(r, 200));
      order.push('end1');
      return { save: { ...current!, refreshToken: 'r-1c' }, result: undefined };
    });
    await new Promise((r) => setTimeout(r, 50));
    const other = store.withCredentialsLock(2, async () => {
      order.push('other');
      return { result: undefined };
    });
    const second = store.withCredentialsLock(1, async (current) => {
      order.push(`start2:${current?.refreshToken}`);
      return { result: undefined };
    });
    await Promise.all([slow, other, second]);
    expect(order).toEqual(['start1:r-1b', 'other', 'end1', 'start2:r-1c']);
    await expect(store.withCredentialsLock(1, async () => ({ save: account(2), result: 1 }))).rejects.toThrow(/mismatch/);
  });
});
