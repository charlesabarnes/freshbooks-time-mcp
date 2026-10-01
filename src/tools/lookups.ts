import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';
import { guarded, ok } from './result.js';
import { ref } from './schemas.js';

const normalize = (s: string) => s.trim().toLowerCase();
const matches = (search: string | undefined, ...fields: (string | null | undefined)[]) =>
  !search || fields.some((f) => f && normalize(f).includes(normalize(search)));

const search = z.string().optional().describe('Case-insensitive text to match in names.');
const limit = z.number().int().min(1).max(500).optional().describe('Maximum results, default 50.');

export function registerLookupTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'lookup_clients',
    {
      title: 'Find clients',
      description: 'List or search FreshBooks clients by organization, person name or email. Returns ids usable in other tools.',
      inputSchema: { search, include_archived: z.boolean().optional().describe('Include archived/deleted clients.'), limit },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const all = await ctx.catalog.clients();
      const found = all
        .filter((c) => args.include_archived || (c.client?.vis_state ?? 0) === 0)
        .filter((c) => matches(args.search, c.name, c.client?.email, c.client?.fname, c.client?.lname))
        .sort((a, b) => a.name.localeCompare(b.name));
      const shown = found.slice(0, args.limit ?? 50);
      const clients = shown.map((c) => ({ id: c.id, name: c.name, email: c.client?.email ?? null, archived: (c.client?.vis_state ?? 0) !== 0 }));
      const text = [`${found.length} client(s)${found.length > shown.length ? `, showing ${shown.length}` : ''}`, ...clients.map((c) => `#${c.id} ${c.name}${c.email ? ` <${c.email}>` : ''}${c.archived ? ' (archived)' : ''}`)];
      return ok(text.join('\n'), { total: found.length, clients });
    }),
  );

  server.registerTool(
    'lookup_projects',
    {
      title: 'Find projects',
      description: 'List or search FreshBooks projects, optionally for one client. Shows each project\'s client and services. Active projects only unless include_inactive is set.',
      inputSchema: {
        search,
        client: ref('Client').optional(),
        include_inactive: z.boolean().optional().describe('Include inactive and completed projects.'),
        limit,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const clientId = args.client !== undefined ? (await ctx.catalog.resolveClient(args.client)).id : undefined;
      const [projects, names] = await Promise.all([ctx.catalog.projects(), ctx.catalog.names()]);
      const found = projects
        .filter((p) => args.include_inactive || (p.project?.active !== false && p.project?.complete !== true))
        .filter((p) => clientId === undefined || p.clientId === clientId)
        .filter((p) => matches(args.search, p.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      const shown = found.slice(0, args.limit ?? 50);
      const list = shown.map((p) => ({
        id: p.id,
        title: p.name,
        client: p.clientId ? { id: p.clientId, name: names.clients.get(p.clientId) ?? `Client ${p.clientId}` } : null,
        active: p.project?.active ?? null,
        complete: p.project?.complete ?? null,
        services: (p.project?.services ?? []).map((s) => ({ id: s.id, name: s.name })),
      }));
      const text = [
        `${found.length} project(s)${found.length > shown.length ? `, showing ${shown.length}` : ''}`,
        ...list.map(
          (p) =>
            `#${p.id} ${p.title}${p.client ? ` (${p.client.name})` : ''}${p.complete ? ' [complete]' : p.active === false ? ' [inactive]' : ''}` +
            (p.services.length ? ` - services: ${p.services.map((s) => s.name).join(', ')}` : ''),
        ),
      ];
      return ok(text.join('\n'), { total: found.length, projects: list });
    }),
  );

  server.registerTool(
    'lookup_services',
    {
      title: 'Find services',
      description: 'List or search FreshBooks services (types of work). With a project, lists the services attached to that project.',
      inputSchema: { search, project: ref('Project').optional(), limit },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      let pool: { id: number; name: string; billable?: boolean }[];
      if (args.project !== undefined) {
        const project = await ctx.catalog.resolveProject(args.project);
        pool = project.project?.services ?? [];
      } else {
        pool = (await ctx.catalog.services()).filter((s) => (s.service?.vis_state ?? 0) === 0).map((s) => ({ id: s.id, name: s.name, billable: s.service?.billable }));
      }
      const found = pool.filter((s) => matches(args.search, s.name)).sort((a, b) => a.name.localeCompare(b.name));
      const shown = found.slice(0, args.limit ?? 50);
      const services = shown.map((s) => ({ id: s.id, name: s.name, billable: s.billable ?? null }));
      const text = [`${found.length} service(s)`, ...services.map((s) => `#${s.id} ${s.name}${s.billable === false ? ' (non-billable)' : ''}`)];
      return ok(text.join('\n'), { total: found.length, services });
    }),
  );

  server.registerTool(
    'account_info',
    {
      title: 'FreshBooks account',
      description: 'Show which FreshBooks user and business this server is connected to, and the default timezone.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async () => {
      const c = await ctx.http.context();
      const data = {
        email: c.email,
        identity_id: c.identityId,
        business_id: c.businessId,
        account_id: c.accountId,
        business_name: c.businessName ?? null,
        default_timezone: ctx.defaultTimeZone,
      };
      return ok(`Connected as ${c.email} to ${c.businessName ?? 'business'} #${c.businessId} (account ${c.accountId}). Default timezone ${ctx.defaultTimeZone}.`, data);
    }),
  );
}
