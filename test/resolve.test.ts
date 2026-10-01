import { describe, expect, it } from 'vitest';
import { Catalog } from '../src/freshbooks/catalog.js';
import type { LookupsApi } from '../src/freshbooks/lookups.js';
import { resolveNamed, ResolutionError } from '../src/freshbooks/resolve.js';
import type { Client, Project, Service } from '../src/freshbooks/types.js';

const items = [
  { id: 1, name: 'Acme Corp' },
  { id: 2, name: 'Acme Labs' },
  { id: 3, name: 'Globex' },
  { id: 4, name: 'globex' },
];

describe('resolveNamed', () => {
  it('resolves numeric ids and numeric strings without a name match', () => {
    expect(resolveNamed('Client', 3, items)).toEqual({ id: 3, name: 'Globex' });
    expect(resolveNamed('Client', '99', items)).toEqual({ id: 99, name: 'Client 99' });
  });

  it('prefers a unique exact match, case and whitespace insensitive', () => {
    expect(resolveNamed('Client', '  acme   corp ', items).id).toBe(1);
  });

  it('falls back to a unique partial match', () => {
    expect(resolveNamed('Client', 'labs', items).id).toBe(2);
  });

  it('fails on ambiguous exact matches, listing candidates', () => {
    expect(() => resolveNamed('Client', 'GLOBEX', items)).toThrow(/ambiguous.*"Globex" \(id 3\).*"globex" \(id 4\)/);
  });

  it('fails on ambiguous partial matches', () => {
    expect(() => resolveNamed('Client', 'acme', items)).toThrow(ResolutionError);
    expect(() => resolveNamed('Client', 'acme', items)).toThrow(/matches several/);
  });

  it('fails clearly when nothing matches', () => {
    expect(() => resolveNamed('Project', 'Initech', items)).toThrow(/No project matches "Initech"/);
  });
});

function catalog(data: { clients?: Partial<Client>[]; projects?: Partial<Project>[]; services?: Partial<Service>[] }) {
  const api = {
    clients: async () => (data.clients ?? []) as Client[],
    projects: async () => (data.projects ?? []) as Project[],
    services: async () => (data.services ?? []) as Service[],
  } as unknown as LookupsApi;
  return new Catalog(api);
}

describe('Catalog.resolveRefs', () => {
  const c = catalog({
    clients: [
      { id: 10, organization: 'Acme Corp', vis_state: 0 },
      { id: 11, organization: '', fname: 'Jane', lname: 'Doe', vis_state: 0 },
      { id: 12, organization: 'Old Acme Corp', vis_state: 1 },
    ],
    projects: [
      { id: 20, title: 'Website', client_id: 10, active: true, services: [{ id: 30, name: 'Development' }] },
      { id: 21, title: 'Website', client_id: 11, active: true },
      { id: 22, title: 'Retired', client_id: 10, active: false },
    ],
    services: [
      { id: 30, name: 'Development', vis_state: 0 },
      { id: 31, name: 'Design', vis_state: 0 },
    ],
  });

  it('infers the client from the project', async () => {
    const refs = await c.resolveRefs({ project: 'retired' });
    expect(refs).toMatchObject({ projectId: 22, clientId: 10, client: { name: 'Acme Corp' } });
  });

  it('uses the client to disambiguate project names', async () => {
    await expect(c.resolveRefs({ project: 'Website' })).rejects.toThrow(/ambiguous/);
    const refs = await c.resolveRefs({ client: 'Jane Doe', project: 'Website' });
    expect(refs).toMatchObject({ clientId: 11, projectId: 21 });
  });

  it('ignores archived clients unless only they match', async () => {
    expect((await c.resolveRefs({ client: 'acme corp' })).clientId).toBe(10);
    expect((await c.resolveRefs({ client: 'old acme' })).clientId).toBe(12);
  });

  it('rejects a project that belongs to a different client', async () => {
    await expect(c.resolveRefs({ client: 'Jane Doe', project: 20 })).rejects.toThrow(/belongs to client id 10/);
  });

  it('resolves services within the project first, then globally', async () => {
    expect((await c.resolveRefs({ project: 20, service: 'dev' })).serviceId).toBe(30);
    expect((await c.resolveRefs({ project: 20, service: 'design' })).serviceId).toBe(31);
  });
});
