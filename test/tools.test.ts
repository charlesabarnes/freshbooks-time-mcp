import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { CredentialManager } from '../src/freshbooks/credentials.js';
import { FreshBooksHttp } from '../src/freshbooks/http.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { fakeFetch, json, type Recorded } from './support/fakeFetch.js';
import { MemoryStore } from './support/memoryStore.js';

const NOW = new Date('2026-10-01T16:00:00Z');
const TT = '/timetracking/business/555';

function freshbooks(extra: ((req: Recorded) => Response | undefined)[] = []) {
  return fakeFetch([
    ...extra,
    (req) =>
      req.url.pathname === '/accounting/account/xYz12/users/clients'
        ? json({
            response: {
              result: {
                clients: [
                  { id: 10, organization: 'Acme Corp', vis_state: 0 },
                  { id: 11, organization: 'Globex', vis_state: 0 },
                ],
                page: 1,
                pages: 1,
                per_page: 100,
                total: 2,
              },
            },
          })
        : undefined,
    (req) =>
      req.url.pathname === '/projects/business/555/projects'
        ? json({
            projects: [
              { id: 20, title: 'Website Redesign', client_id: 10, active: true, complete: false, services: [{ id: 30, name: 'Development' }] },
              { id: 21, title: 'Website Hosting', client_id: 11, active: true, complete: false, services: [] },
            ],
            meta: { page: 1, pages: 1, per_page: 100, total: 2 },
          })
        : undefined,
    (req) =>
      req.url.pathname === '/comments/business/555/services'
        ? json({ services: [{ id: 30, name: 'Development', vis_state: 0 }, { id: 31, name: 'Design', vis_state: 0 }], meta: { page: 1, pages: 1, per_page: 100, total: 2 } })
        : undefined,
  ]);
}

async function connect(fetchImpl: typeof fetch) {
  const store = new MemoryStore();
  await store.saveCredentials({
    identityId: 4242,
    email: 'charles@example.com',
    businessId: 555,
    accountId: 'xYz12',
    businessName: 'Barnes LLC',
    accessToken: 'fb-access',
    refreshToken: 'fb-refresh',
    accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000),
    redirectUri: 'https://x/oauth/callback',
  });
  const credentials = new CredentialManager({ store, app: () => ({ clientId: 'a', clientSecret: 'b' }), fetchImpl, now: () => NOW });
  const server = buildMcpServer({ http: new FreshBooksHttp(credentials, 4242, fetchImpl), defaultTimeZone: 'America/New_York', now: () => NOW });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (res: any) => res.content.map((c: any) => c.text).join('\n');

describe('time entry tools', () => {
  it('creates an entry from names, inferring client and timezone-aware start', async () => {
    const { fetch, calls } = freshbooks([
      (req) =>
        req.method === 'POST' && req.url.pathname === `${TT}/time_entries`
          ? json({ time_entry: { id: 900, ...req.body.time_entry, active: true, billable: true, billed: false, timer: null } })
          : undefined,
    ]);
    const client = await connect(fetch);
    const res: any = await client.callTool({
      name: 'time_create_entry',
      arguments: { duration: '1h30m', date: '2026-09-29', start_time: '13:00', project: 'redesign', service: 'dev', note: 'Homepage' },
    });
    expect(res.isError).toBeFalsy();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body.time_entry).toMatchObject({
      is_logged: true,
      duration: 5400,
      started_at: '2026-09-29T17:00:00.000Z',
      client_id: 10,
      project_id: 20,
      service_id: 30,
      note: 'Homepage',
      identity_id: 4242,
    });
    expect(text(res)).toContain('Acme Corp / Website Redesign / Development');
    expect(res.structuredContent.entry.hours).toBe(1.5);
  });

  it('returns a clear error on ambiguous names', async () => {
    const { fetch, calls } = freshbooks();
    const client = await connect(fetch);
    const res: any = await client.callTool({ name: 'time_create_entry', arguments: { duration: 1, project: 'website' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/matches several.*Website Hosting.*Website Redesign|matches several.*Website Redesign.*Website Hosting/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('lists entries with local-day UTC bounds and client filter', async () => {
    const { fetch, calls } = freshbooks([
      (req) =>
        req.method === 'GET' && req.url.pathname === `${TT}/time_entries`
          ? json({
              time_entries: [
                { id: 1, started_at: '2026-09-30T14:00:00Z', duration: 3600, client_id: 10, project_id: 20, service_id: null, note: 'a', is_logged: true, active: true, billable: true, billed: false, timer: null },
              ],
              meta: { page: 1, pages: 1, per_page: 50, total: 1 },
            })
          : undefined,
    ]);
    const client = await connect(fetch);
    const res: any = await client.callTool({ name: 'time_list_entries', arguments: { from: '2026-09-30', to: '2026-09-30', client: 'acme' } });
    expect(res.isError).toBeFalsy();
    const get = calls.find((c) => c.url.pathname === `${TT}/time_entries`)!;
    expect(Object.fromEntries(get.url.searchParams)).toMatchObject({
      started_from: '2026-09-30T04:00:00',
      started_to: '2026-10-01T03:59:59',
      client_id: '10',
      page: '1',
      per_page: '50',
    });
    expect(text(res)).toContain('#1 2026-09-30 10:00 1h | Acme Corp / Website Redesign | unbilled - a');
  });

  it('updates only the given fields, keeping the rest', async () => {
    const existing = { id: 5, started_at: '2026-09-30T14:00:00Z', duration: 3600, client_id: 10, project_id: 20, service_id: 30, note: 'old', is_logged: true, active: true, billable: true, billed: false, internal: false, timer: null, identity_id: 4242 };
    const { fetch, calls } = freshbooks([
      (req) => (req.method === 'GET' && req.url.pathname === `${TT}/time_entries/5` ? json({ time_entry: existing }) : undefined),
      (req) => (req.method === 'PUT' ? json({ time_entry: { ...existing, ...req.body.time_entry } }) : undefined),
    ]);
    const client = await connect(fetch);
    const res: any = await client.callTool({ name: 'time_update_entry', arguments: { id: 5, start_time: '08:30', note: 'new' } });
    expect(res.isError).toBeFalsy();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body.time_entry).toEqual({
      is_logged: true,
      started_at: '2026-09-30T12:30:00.000Z',
      duration: 3600,
      note: 'new',
      client_id: 10,
      project_id: 20,
      service_id: 30,
      billable: true,
      internal: false,
    });
  });

  it('deletes an entry', async () => {
    const { fetch, calls } = freshbooks([
      (req) => (req.method === 'GET' && req.url.pathname === `${TT}/time_entries/5` ? json({ time_entry: { id: 5, started_at: '2026-09-30T14:00:00Z', duration: 60, client_id: 10, project_id: null, service_id: null, note: null, is_logged: true, active: true, timer: null } }) : undefined),
      (req) => (req.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined),
    ]);
    const client = await connect(fetch);
    const res: any = await client.callTool({ name: 'time_delete_entry', arguments: { id: 5 } });
    expect(res.structuredContent).toMatchObject({ deleted: true, id: 5 });
    expect(calls.find((c) => c.method === 'DELETE')!.url.pathname).toBe(`${TT}/time_entries/5`);
  });
});

describe('timer tools', () => {
  const running = {
    id: 77,
    is_running: true,
    time_entries: [
      { id: 1, started_at: '2026-10-01T15:00:00Z', duration: null, client_id: 10, project_id: 20, service_id: null, note: 'focus', is_logged: false, active: true, identity_id: 4242, created_at: '2026-10-01T15:00:00Z', timer: { id: 77, is_running: true } },
    ],
  };

  it('starts a timer with resolved details', async () => {
    let timers: unknown[] = [];
    const { fetch, calls } = freshbooks([
      (req) => (req.method === 'GET' && req.url.pathname === `${TT}/timers` ? json({ timers }) : undefined),
      (req) => {
        if (req.method !== 'POST') return undefined;
        timers = [running];
        return json({ time_entry: { id: 1, ...req.body.time_entry, timer: { id: 77, is_running: true } } });
      },
    ]);
    const client = await connect(fetch);
    const res: any = await client.callTool({ name: 'timer_start', arguments: { project: 20, note: 'focus' } });
    expect(res.isError).toBeFalsy();
    expect(calls.find((c) => c.method === 'POST')!.body.time_entry).toEqual({
      is_logged: false,
      started_at: NOW.toISOString(),
      identity_id: 4242,
      client_id: 10,
      project_id: 20,
      note: 'focus',
    });
    expect(text(res)).toMatch(/Started\. Running timer #77: 1h since 2026-10-01 11:00/);
  });

  it('refuses to start a second timer', async () => {
    const { fetch } = freshbooks([(req) => (req.url.pathname === `${TT}/timers` ? json({ timers: [running] }) : undefined)]);
    const client = await connect(fetch);
    const res: any = await client.callTool({ name: 'timer_start', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/already running/);
  });

  it('stops the timer by logging its entries', async () => {
    const { fetch, calls } = freshbooks([
      (req) => (req.method === 'GET' && req.url.pathname === `${TT}/timers` ? json({ timers: [running] }) : undefined),
      (req) =>
        req.method === 'PUT' && req.url.pathname === `${TT}/timers/77`
          ? json({ timer: { id: 77, is_running: false, time_entries: req.body.timer.time_entries.map((e: any) => ({ ...e, is_logged: true })) } })
          : undefined,
    ]);
    const client = await connect(fetch);
    const res: any = await client.callTool({ name: 'timer_stop', arguments: { service: 'Development' } });
    expect(res.isError).toBeFalsy();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body.timer.time_entries).toEqual([
      { id: 1, started_at: '2026-10-01T15:00:00Z', duration: 3600, client_id: 10, project_id: 20, service_id: 30, note: 'focus', is_logged: false, timer: { id: 77 } },
    ]);
    expect(res.structuredContent).toMatchObject({ timer_id: 77, logged_seconds: 3600, logged_hours: 1 });
  });

  it('discards the timer', async () => {
    const { fetch, calls } = freshbooks([
      (req) => (req.method === 'GET' && req.url.pathname === `${TT}/timers` ? json({ timers: [running] }) : undefined),
      (req) => (req.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined),
    ]);
    const client = await connect(fetch);
    const res: any = await client.callTool({ name: 'timer_discard', arguments: {} });
    expect(res.structuredContent.discarded).toBe(true);
    expect(calls.find((c) => c.method === 'DELETE')!.url.pathname).toBe(`${TT}/timers/77`);
  });
});

describe('time_summary tool', () => {
  it('aggregates all pages for the period', async () => {
    const page = (n: number) => ({
      time_entries: [
        { id: n, started_at: n === 1 ? '2026-09-29T14:00:00Z' : '2026-09-30T02:00:00Z', duration: 7200, client_id: n === 1 ? 10 : 11, project_id: null, service_id: null, note: null, is_logged: true, active: true, billable: true, billed: n === 2, timer: null },
      ],
      meta: { page: n, pages: 2, per_page: 100, total: 2 },
    });
    const { fetch, calls } = freshbooks([
      (req) => (req.url.pathname === `${TT}/time_entries` ? json(page(Number(req.url.searchParams.get('page')))) : undefined),
    ]);
    const client = await connect(fetch);
    const res: any = await client.callTool({ name: 'time_summary', arguments: { period: 'this_week', group_by: ['day', 'client'] } });
    expect(res.isError).toBeFalsy();
    expect(calls.filter((c) => c.url.pathname === `${TT}/time_entries`)).toHaveLength(2);
    expect(res.structuredContent.from).toBe('2026-09-28');
    expect(res.structuredContent.totals).toMatchObject({ hours: 4, unbilled_hours: 2, billed_hours: 2 });
    expect(res.structuredContent.groups.day.map((d: any) => d.key)).toEqual(['2026-09-29']);
    expect(text(res)).toContain('Acme Corp: 2h');
  });
});
