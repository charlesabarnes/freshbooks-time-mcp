import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { fakeFetch, json, type Recorded } from './support/fakeFetch.js';
import { MemoryStore } from './support/memoryStore.js';

const HOST = '127.0.0.1:4100';
const BASE = `http://${HOST}`;
const CLIENT_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const configured = (overrides: Record<string, string> = {}): Config =>
  loadConfig({
    FRESHBOOKS_CLIENT_ID: 'fb-client',
    FRESHBOOKS_CLIENT_SECRET: 'fb-secret',
    ALLOWED_FRESHBOOKS_EMAIL: 'Charles@Example.com',
    DEFAULT_TIMEZONE: 'America/New_York',
    ...overrides,
  });

function freshbooksApi(email: string) {
  return (req: Recorded) => {
    if (req.url.pathname === '/auth/oauth/token') {
      if (req.body.grant_type !== 'authorization_code' || req.body.code !== 'fb-code') return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'fb-access', refresh_token: 'fb-refresh', expires_in: 43200, created_at: Math.floor(Date.now() / 1000) });
    }
    if (req.url.pathname === '/auth/api/v1/users/me') {
      return json({
        response: {
          id: 4242,
          email,
          business_memberships: [{ id: 1, role: 'owner', business: { id: 555, name: 'Barnes LLC', account_id: 'xYz12' } }],
        },
      });
    }
    return undefined;
  };
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(app: ReturnType<typeof createApp>) {
  const res = await request(app)
    .post('/register')
    .set('Host', HOST)
    .send({ client_name: 'Claude', redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

async function authorize(app: ReturnType<typeof createApp>, clientId: string, challenge: string) {
  const res = await request(app).get('/authorize').set('Host', HOST).query({
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
    resource: `${BASE}/mcp`,
  });
  return res;
}

async function signIn(app: ReturnType<typeof createApp>) {
  const clientId = await register(app);
  const { verifier, challenge } = pkce();
  const auth = await authorize(app, clientId, challenge);
  const fbState = new URL(auth.headers.location!).searchParams.get('state');
  const cb = await request(app).get('/oauth/freshbooks/callback').set('Host', HOST).query({ code: 'fb-code', state: fbState });
  return { clientId, verifier, callback: cb };
}

async function tokenRequest(app: ReturnType<typeof createApp>, form: Record<string, string>) {
  return request(app).post('/token').set('Host', HOST).type('form').send(form);
}

describe('metadata', () => {
  it('serves authorization server and protected resource metadata without FreshBooks secrets', async () => {
    const app = createApp({ config: loadConfig({}), store: new MemoryStore() });
    const as = await request(app).get('/.well-known/oauth-authorization-server').set('Host', HOST);
    expect(as.status).toBe(200);
    expect(as.body).toMatchObject({
      issuer: `${BASE}/`,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      code_challenge_methods_supported: ['S256'],
    });
    const prm = await request(app).get('/.well-known/oauth-protected-resource/mcp').set('Host', HOST);
    expect(prm.body).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [`${BASE}/`] });
    const health = await request(app).get('/healthz').set('Host', HOST);
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, auth_configured: false, freshbooks_connected: false });
  });

  it('honours forwarded proto/host and PUBLIC_URL', async () => {
    const app = createApp({ config: loadConfig({}), store: new MemoryStore() });
    const res = await request(app)
      .get('/.well-known/oauth-authorization-server')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'fb.example.com');
    expect(res.body.issuer).toBe('https://fb.example.com/');
    const fixed = createApp({ config: loadConfig({ PUBLIC_URL: 'https://time.example.org/' }), store: new MemoryStore() });
    const res2 = await request(fixed).get('/.well-known/oauth-protected-resource/mcp');
    expect(res2.body.resource).toBe('https://time.example.org/mcp');
  });

  it('returns a clear config error from /authorize until secrets are set', async () => {
    const app = createApp({ config: loadConfig({ FRESHBOOKS_CLIENT_ID: 'x' }), store: new MemoryStore() });
    const res = await request(app).get('/authorize').set('Host', HOST).query({ client_id: 'whatever' });
    expect(res.status).toBe(503);
    expect(res.body.error_description).toMatch(/FRESHBOOKS_CLIENT_SECRET.*ALLOWED_FRESHBOOKS_EMAIL/);
  });

  it('challenges unauthenticated MCP requests with resource metadata', async () => {
    const app = createApp({ config: configured(), store: new MemoryStore() });
    const res = await request(app).post('/mcp').set('Host', HOST).send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  });
});

describe('authorization flow', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it('redirects /authorize to FreshBooks with our callback and a state', async () => {
    const { fetch } = fakeFetch([freshbooksApi('charles@example.com')]);
    const app = createApp({ config: configured(), store, fetchImpl: fetch });
    const clientId = await register(app);
    const res = await authorize(app, clientId, pkce().challenge);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location!);
    expect(location.origin + location.pathname).toBe('https://auth.freshbooks.com/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('fb-client');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('redirect_uri')).toBe(`${BASE}/oauth/freshbooks/callback`);
    expect(location.searchParams.get('state')).toBeTruthy();
  });

  it('rejects unregistered redirect URIs before contacting FreshBooks', async () => {
    const app = createApp({ config: configured(), store });
    const clientId = await register(app);
    const res = await request(app).get('/authorize').set('Host', HOST).query({
      client_id: clientId,
      redirect_uri: 'https://evil.example/cb',
      response_type: 'code',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
  });

  it('completes sign-in for the allowed email and enforces PKCE', async () => {
    const { fetch, calls } = fakeFetch([freshbooksApi('charles@example.com')]);
    const app = createApp({ config: configured(), store, fetchImpl: fetch });
    const { clientId, verifier, callback } = await signIn(app);

    expect(callback.status).toBe(302);
    const back = new URL(callback.headers.location!);
    expect(back.origin + back.pathname).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get('state')).toBe('client-state');
    const code = back.searchParams.get('code')!;
    expect(code).toBeTruthy();

    expect(calls.find((c) => c.url.pathname === '/auth/oauth/token')!.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'fb-code',
      client_id: 'fb-client',
      client_secret: 'fb-secret',
      redirect_uri: `${BASE}/oauth/freshbooks/callback`,
    });
    expect(store.credentials).toMatchObject({ email: 'charles@example.com', identityId: 4242, businessId: 555, accountId: 'xYz12', refreshToken: 'fb-refresh' });

    const bad = await tokenRequest(app, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: 'wrong'.repeat(10), redirect_uri: CLIENT_REDIRECT });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_grant');

    const good = await tokenRequest(app, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: CLIENT_REDIRECT });
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });

    const reused = await tokenRequest(app, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier });
    expect(reused.status).toBe(400);

    const refreshed = await tokenRequest(app, { grant_type: 'refresh_token', client_id: clientId, refresh_token: good.body.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).not.toBe(good.body.access_token);
    const replay = await tokenRequest(app, { grant_type: 'refresh_token', client_id: clientId, refresh_token: good.body.refresh_token });
    expect(replay.status).toBe(400);

    const mcp = await request(app)
      .post('/mcp')
      .set('Host', HOST)
      .set('Authorization', `Bearer ${refreshed.body.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(mcp.status).toBe(200);
    const names = mcp.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['time_list_entries', 'time_create_entry', 'timer_start', 'timer_stop', 'time_summary', 'lookup_projects']));
    const destructive = mcp.body.result.tools.filter((t: any) => t.annotations?.destructiveHint).map((t: any) => t.name).sort();
    expect(destructive).toEqual(['time_delete_entry', 'timer_discard']);
  });

  it('refuses a FreshBooks identity whose email is not allowed', async () => {
    const { fetch } = fakeFetch([freshbooksApi('someone@else.com')]);
    const app = createApp({ config: configured(), store, fetchImpl: fetch });
    const { callback } = await signIn(app);
    const back = new URL(callback.headers.location!);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
    expect(store.credentials).toBeUndefined();
  });

  it('refuses everyone when ALLOWED_FRESHBOOKS_EMAIL is unset', async () => {
    const { fetch } = fakeFetch([freshbooksApi('charles@example.com')]);
    const config = configured();
    const app = createApp({ config: { ...config, allowedEmail: undefined }, store, fetchImpl: fetch });
    const clientId = await register(app);
    const res = await authorize(app, clientId, pkce().challenge);
    expect(res.status).toBe(503);
  });

  it('rejects unknown callback state', async () => {
    const app = createApp({ config: configured(), store });
    const res = await request(app).get('/oauth/freshbooks/callback').set('Host', HOST).query({ code: 'fb-code', state: 'nope' });
    expect(res.status).toBe(400);
  });

  it('invalidates access tokens if the allowlist changes', async () => {
    const { fetch } = fakeFetch([freshbooksApi('charles@example.com')]);
    const config = configured();
    const app = createApp({ config, store, fetchImpl: fetch });
    const { clientId, verifier, callback } = await signIn(app);
    const code = new URL(callback.headers.location!).searchParams.get('code')!;
    const tokens = await tokenRequest(app, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier });
    config.allowedEmail = 'other@example.com';
    const res = await request(app)
      .post('/mcp')
      .set('Host', HOST)
      .set('Authorization', `Bearer ${tokens.body.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
  });
});
