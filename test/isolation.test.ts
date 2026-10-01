import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { fakeFetch, json, type Recorded } from './support/fakeFetch.js';
import { MemoryStore } from './support/memoryStore.js';

const HOST = '127.0.0.1:4200';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const USERS = {
  alice: { code: 'code-alice', id: 1001, email: 'alice@example.com', business: 501, account: 'ALICE' },
  bob: { code: 'code-bob', id: 2002, email: 'bob@example.com', business: 502, account: 'BOB' },
  eve: { code: 'code-eve', id: 3003, email: 'eve@example.com', business: 503, account: 'EVE' },
} as const;

type UserKey = keyof typeof USERS;

function freshbooks() {
  let generation = 0;
  const byAccess = new Map<string, UserKey>();
  const validRefresh = new Map<string, UserKey>();
  const issue = (user: UserKey) => {
    generation += 1;
    const access = `fb-access-${user}-${generation}`;
    const refresh = `fb-refresh-${user}-${generation}`;
    byAccess.set(access, user);
    for (const [token, owner] of validRefresh) if (owner === user) validRefresh.delete(token);
    validRefresh.set(refresh, user);
    return json({ access_token: access, refresh_token: refresh, expires_in: 43200, created_at: Math.floor(Date.now() / 1000) });
  };
  const handler = (req: Recorded) => {
    if (req.url.pathname === '/auth/oauth/token') {
      if (req.body.grant_type === 'authorization_code') {
        const user = (Object.keys(USERS) as UserKey[]).find((k) => USERS[k].code === req.body.code);
        return user ? issue(user) : json({ error: 'invalid_grant' }, 400);
      }
      const owner = validRefresh.get(req.body.refresh_token);
      return owner ? issue(owner) : json({ error: 'invalid_grant' }, 400);
    }
    const user = byAccess.get((req.headers.authorization ?? '').replace('Bearer ', ''));
    if (!user) return json({ error: 'unauthenticated' }, 401);
    const u = USERS[user];
    if (req.url.pathname === '/auth/api/v1/users/me') {
      return json({ response: { id: u.id, email: u.email, business_memberships: [{ business: { id: u.business, name: user, account_id: u.account } }] } });
    }
    if (req.url.pathname === `/timetracking/business/${u.business}/time_entries`) {
      return json({
        time_entries: [{ id: u.id, started_at: '2026-09-30T14:00:00Z', duration: 3600, client_id: null, project_id: null, service_id: null, note: `${user}'s secret`, is_logged: true, active: true, internal: true, timer: null }],
        meta: { page: 1, pages: 1, per_page: 50, total: 1 },
      });
    }
    if (req.url.pathname.startsWith('/timetracking/') || req.url.pathname.startsWith('/accounting/')) return json({ error: 'forbidden' }, 403);
    if (req.url.pathname.startsWith('/projects/') || req.url.pathname.startsWith('/comments/')) {
      return json({ projects: [], services: [], meta: { page: 1, pages: 1, per_page: 100, total: 0 } });
    }
    return undefined;
  };
  return { ...fakeFetch([handler]), byAccess };
}

async function signIn(app: ReturnType<typeof createApp>, user: UserKey) {
  const reg = await request(app).post('/register').set('Host', HOST).send({ client_name: user, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  const clientId = reg.body.client_id as string;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const auth = await request(app).get('/authorize').set('Host', HOST).query({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: user,
  });
  const state = new URL(auth.headers.location!).searchParams.get('state');
  const cb = await request(app).get('/oauth/callback').set('Host', HOST).query({ code: USERS[user].code, state });
  const back = new URL(cb.headers.location!);
  const code = back.searchParams.get('code');
  if (!code) return { clientId, error: back.searchParams.get('error'), tokens: undefined };
  const tokens = await request(app)
    .post('/token')
    .set('Host', HOST)
    .type('form')
    .send({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
  return { clientId, error: undefined, tokens: tokens.body as { access_token: string; refresh_token: string } };
}

async function callTool(app: ReturnType<typeof createApp>, accessToken: string, name: string, args: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/mcp')
    .set('Host', HOST)
    .set('Authorization', `Bearer ${accessToken}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return res;
}

function setup(allow: string) {
  const store = new MemoryStore();
  const fb = freshbooks();
  const config = loadConfig({ FRESHBOOKS_CLIENT_ID: 'id', FRESHBOOKS_CLIENT_SECRET: 'secret', ALLOWED_FRESHBOOKS_EMAILS: allow });
  const app = createApp({ config, store, fetchImpl: fb.fetch });
  return { store, fb, app };
}

describe('multi-user isolation', () => {
  it('stores FreshBooks tokens per identity and routes each caller to their own account', async () => {
    const { store, fb, app } = setup('alice@example.com,BOB@example.com');
    const alice = await signIn(app, 'alice');
    const bob = await signIn(app, 'bob');
    expect(store.accounts.size).toBe(2);
    expect(store.accounts.get(1001)).toMatchObject({ email: 'alice@example.com', businessId: 501, accountId: 'ALICE' });
    expect(store.accounts.get(2002)).toMatchObject({ email: 'bob@example.com', businessId: 502, accountId: 'BOB' });
    expect([...store.tokens.values()].filter((t) => t.identityId === 1001)).toHaveLength(2);
    expect([...store.tokens.values()].filter((t) => t.identityId === 2002)).toHaveLength(2);

    fb.calls.length = 0;
    const a = await callTool(app, alice.tokens!.access_token, 'time_list_entries', { from: '2026-09-30', to: '2026-09-30' });
    const aliceCalls = fb.calls.splice(0);
    const b = await callTool(app, bob.tokens!.access_token, 'time_list_entries', { from: '2026-09-30', to: '2026-09-30' });
    const bobCalls = fb.calls.splice(0);

    expect(a.body.result.isError).toBeFalsy();
    expect(JSON.stringify(a.body.result)).toContain("alice's secret");
    expect(JSON.stringify(a.body.result)).not.toContain('bob');
    expect(JSON.stringify(b.body.result)).toContain("bob's secret");
    expect(JSON.stringify(b.body.result)).not.toContain('alice');

    expect(aliceCalls.every((c) => fb.byAccess.get(c.headers.authorization!.replace('Bearer ', '')) === 'alice')).toBe(true);
    expect(bobCalls.every((c) => fb.byAccess.get(c.headers.authorization!.replace('Bearer ', '')) === 'bob')).toBe(true);
    expect(aliceCalls.some((c) => c.url.pathname.includes('/502/') || c.url.pathname.includes('/BOB/'))).toBe(false);

    const info = await callTool(app, bob.tokens!.access_token, 'account_info');
    expect(info.body.result.structuredContent).toMatchObject({ email: 'bob@example.com', business_id: 502 });
  });

  it('refreshes one identity without touching the other', async () => {
    const { store, fb, app } = setup('alice@example.com,bob@example.com');
    const alice = await signIn(app, 'alice');
    await signIn(app, 'bob');
    const bobBefore = { ...store.accounts.get(2002)! };
    const aliceAccount = store.accounts.get(1001)!;
    aliceAccount.accessTokenExpiresAt = new Date(Date.now() - 1000);

    fb.calls.length = 0;
    const res = await callTool(app, alice.tokens!.access_token, 'account_info');
    expect(res.body.result.structuredContent.email).toBe('alice@example.com');
    const refreshes = fb.calls.filter((c) => c.url.pathname === '/auth/oauth/token');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.body.refresh_token).toMatch(/^fb-refresh-alice-/);
    expect(store.accounts.get(1001)!.refreshToken).not.toBe(aliceAccount.refreshToken);
    expect(store.accounts.get(2002)).toEqual(bobBefore);
  });

  it('keeps MCP refresh tokens bound to their identity and client', async () => {
    const { app } = setup('alice@example.com,bob@example.com');
    const alice = await signIn(app, 'alice');
    const bob = await signIn(app, 'bob');
    const stolen = await request(app)
      .post('/token')
      .set('Host', HOST)
      .type('form')
      .send({ grant_type: 'refresh_token', client_id: bob.clientId, refresh_token: alice.tokens!.refresh_token });
    expect(stolen.status).toBe(400);

    const own = await request(app)
      .post('/token')
      .set('Host', HOST)
      .type('form')
      .send({ grant_type: 'refresh_token', client_id: alice.clientId, refresh_token: alice.tokens!.refresh_token });
    expect(own.status).toBe(200);
    const info = await callTool(app, own.body.access_token, 'account_info');
    expect(info.body.result.structuredContent.email).toBe('alice@example.com');
  });

  it('refuses identities outside the allowlist without storing their tokens', async () => {
    const { store, app } = setup('alice@example.com');
    const eve = await signIn(app, 'eve');
    expect(eve.error).toBe('access_denied');
    expect(store.accounts.has(3003)).toBe(false);
  });

  it('admits any FreshBooks identity with *', async () => {
    const { store, app } = setup('*');
    const eve = await signIn(app, 'eve');
    const alice = await signIn(app, 'alice');
    expect(eve.error).toBeUndefined();
    expect(alice.error).toBeUndefined();
    expect(store.accounts.size).toBe(2);
    const info = await callTool(app, eve.tokens!.access_token, 'account_info');
    expect(info.body.result.structuredContent.email).toBe('eve@example.com');
  });

  it('revokes access when an identity is removed from the allowlist', async () => {
    const { app, store } = setup('alice@example.com,bob@example.com');
    const alice = await signIn(app, 'alice');
    const bob = await signIn(app, 'bob');
    const config = loadConfig({ FRESHBOOKS_CLIENT_ID: 'id', FRESHBOOKS_CLIENT_SECRET: 'secret', ALLOWED_FRESHBOOKS_EMAILS: 'bob@example.com' });
    const narrowed = createApp({ config, store, fetchImpl: freshbooks().fetch });
    expect((await callTool(narrowed, alice.tokens!.access_token, 'account_info')).status).toBe(401);
    expect((await callTool(narrowed, bob.tokens!.access_token, 'account_info')).status).toBe(200);
  });
});
