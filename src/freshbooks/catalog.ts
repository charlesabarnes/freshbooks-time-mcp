import type { LookupsApi } from './lookups.js';
import { isIdRef, resolveNamed, ResolutionError, type Named, type Ref } from './resolve.js';
import { clientName, type Client, type Project, type Service } from './types.js';

export interface NamedClient extends Named {
  client: Client | undefined;
}

export interface NamedProject extends Named {
  clientId: number | null;
  project: Project | undefined;
}

export interface NamedService extends Named {
  service: Service | undefined;
}

export interface ResolvedRefs {
  clientId?: number;
  projectId?: number;
  serviceId?: number;
  client?: Named;
  project?: Named;
  service?: Named;
}

export class Catalog {
  private clientsP: Promise<NamedClient[]> | undefined;
  private projectsP: Promise<NamedProject[]> | undefined;
  private servicesP: Promise<NamedService[]> | undefined;

  constructor(private readonly api: LookupsApi) {}

  clients(): Promise<NamedClient[]> {
    this.clientsP ??= this.api.clients().then((list) => list.map((c) => ({ id: c.id, name: clientName(c), client: c })));
    return this.clientsP;
  }

  projects(): Promise<NamedProject[]> {
    this.projectsP ??= this.api
      .projects()
      .then((list) => list.map((p) => ({ id: p.id, name: p.title, clientId: p.client_id, project: p })));
    return this.projectsP;
  }

  services(): Promise<NamedService[]> {
    this.servicesP ??= this.api.services().then((list) => list.map((s) => ({ id: s.id, name: s.name, service: s })));
    return this.servicesP;
  }

  async names(): Promise<{ clients: Map<number, string>; projects: Map<number, string>; services: Map<number, string> }> {
    const [clients, projects, services] = await Promise.all([
      this.clients().catch(() => []),
      this.projects().catch(() => []),
      this.services().catch(() => []),
    ]);
    const toMap = (items: Named[]) => new Map(items.map((i) => [i.id, i.name]));
    const serviceMap = toMap(services);
    for (const p of projects) for (const s of p.project?.services ?? []) if (!serviceMap.has(s.id)) serviceMap.set(s.id, s.name);
    return { clients: toMap(clients), projects: toMap(projects), services: serviceMap };
  }

  async resolveClient(ref: Ref): Promise<Named> {
    const clients = await this.clients();
    const active = clients.filter((c) => (c.client?.vis_state ?? 0) === 0);
    try {
      return resolveNamed('Client', ref, active);
    } catch (error) {
      if (error instanceof ResolutionError && !isIdRef(ref) && active.length !== clients.length) {
        return resolveNamed('Client', ref, clients);
      }
      throw error;
    }
  }

  async resolveProject(ref: Ref, clientId?: number): Promise<Named & { clientId: number | null; project?: Project }> {
    const projects = await this.projects();
    if (isIdRef(ref)) {
      const found = projects.find((p) => p.id === Number(ref));
      return found ?? { id: Number(ref), name: `Project ${ref}`, clientId: null };
    }
    const scoped = clientId === undefined ? projects : projects.filter((p) => p.clientId === clientId);
    const active = scoped.filter((p) => p.project?.active !== false);
    const pool = active.length ? active : scoped;
    try {
      return resolveNamed('Project', ref, pool) as NamedProject;
    } catch (error) {
      if (error instanceof ResolutionError && pool !== scoped) return resolveNamed('Project', ref, scoped) as NamedProject;
      throw error;
    }
  }

  async resolveService(ref: Ref, project?: Project): Promise<Named> {
    if (isIdRef(ref)) {
      const services = await this.services();
      return services.find((s) => s.id === Number(ref)) ?? { id: Number(ref), name: `Service ${ref}` };
    }
    const projectServices = project?.services ?? [];
    if (projectServices.length) {
      try {
        return resolveNamed('Service', ref, projectServices);
      } catch (error) {
        if (!(error instanceof ResolutionError) || /ambiguous|several/.test(error.message)) throw error;
      }
    }
    const services = (await this.services()).filter((s) => (s.service?.vis_state ?? 0) === 0);
    return resolveNamed('Service', ref, services);
  }

  async resolveRefs(refs: { client?: Ref; project?: Ref; service?: Ref }): Promise<ResolvedRefs> {
    const out: ResolvedRefs = {};
    if (refs.client !== undefined) {
      out.client = await this.resolveClient(refs.client);
      out.clientId = out.client.id;
    }
    let project: Project | undefined;
    if (refs.project !== undefined) {
      const resolved = await this.resolveProject(refs.project, out.clientId);
      out.project = resolved;
      out.projectId = resolved.id;
      project = resolved.project;
      if (out.clientId === undefined && resolved.clientId) {
        out.clientId = resolved.clientId;
        const clients = await this.clients().catch(() => []);
        out.client = clients.find((c) => c.id === resolved.clientId) ?? { id: resolved.clientId, name: `Client ${resolved.clientId}` };
      } else if (out.clientId !== undefined && resolved.clientId && resolved.clientId !== out.clientId) {
        throw new ResolutionError(
          `Project "${resolved.name}" belongs to client id ${resolved.clientId}, not "${out.client?.name}" (id ${out.clientId}).`,
        );
      }
    }
    if (refs.service !== undefined) {
      out.service = await this.resolveService(refs.service, project);
      out.serviceId = out.service.id;
    }
    return out;
  }
}
