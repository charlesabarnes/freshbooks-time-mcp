import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { writableFields, type TimeEntryInput } from '../freshbooks/timeEntries.js';
import { ResolutionError } from '../freshbooks/resolve.js';
import { formatDuration, parseDuration, toHours } from '../time/duration.js';
import {
  assertTimeZone,
  freshbooksDateTime,
  resolveDateRange,
  utcRangeForDates,
  zonedDate,
  zonedDateTime,
  zonedToUtc,
  type Period,
} from '../time/tz.js';
import type { ToolContext } from './context.js';
import { entryLine, entryView } from './format.js';
import { guarded, ok } from './result.js';
import { dateString, duration, rangeShape, ref, timeString, timezone } from './schemas.js';

const DEFAULT_START_TIME = '09:00';

function startedAt(
  ctx: ToolContext,
  tz: string,
  durationSeconds: number,
  date: string | undefined,
  startTime: string | undefined,
): Date {
  const today = zonedDate(ctx.now(), tz);
  if (startTime) return zonedToUtc(date ?? today, startTime, tz);
  if (!date || date === today) return new Date(ctx.now().getTime() - durationSeconds * 1000);
  return zonedToUtc(date, DEFAULT_START_TIME, tz);
}

export function registerTimeEntryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'time_list_entries',
    {
      title: 'List time entries',
      description:
        'List logged FreshBooks time entries in a date range (defaults to the last 7 days), optionally filtered by client, project, service, billable and billed status. Returns entry ids for update/delete.',
      inputSchema: {
        ...rangeShape,
        client: ref('Client').optional(),
        project: ref('Project').optional(),
        service: ref('Service').optional(),
        billable: z.boolean().optional().describe('Only billable (true) or non-billable (false) entries.'),
        billed: z.boolean().optional().describe('Only billed (true) or not-yet-billed (false) entries.'),
        include_running: z.boolean().optional().describe('Also include unlogged entries belonging to a running timer.'),
        page: z.number().int().min(1).optional().describe('Page number, default 1.'),
        per_page: z.number().int().min(1).max(100).optional().describe('Entries per page, default 50, max 100.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const tz = assertTimeZone(args.timezone ?? ctx.defaultTimeZone);
      const range = resolveDateRange({ ...args, period: args.period as Period | undefined }, tz, ctx.now(), 'last_7_days');
      const { start, end } = utcRangeForDates(range.from, range.to, tz);
      const refs = await ctx.catalog.resolveRefs({ client: args.client, project: args.project, service: args.service });
      const filters = {
        startedFrom: freshbooksDateTime(start),
        startedTo: freshbooksDateTime(end),
        clientId: refs.clientId,
        billable: args.billable,
        billed: args.billed,
        includeUnlogged: args.include_running,
      };
      const page = args.page ?? 1;
      const perPage = args.per_page ?? 50;
      let entries;
      let meta: { page: number; pages: number; total: number };
      if (refs.projectId !== undefined || refs.serviceId !== undefined) {
        const all = (await ctx.timeEntries.listAll(filters)).filter(
          (e) =>
            (refs.projectId === undefined || e.project_id === refs.projectId) &&
            (refs.serviceId === undefined || e.service_id === refs.serviceId),
        );
        entries = all.slice((page - 1) * perPage, page * perPage);
        meta = { page, pages: Math.max(1, Math.ceil(all.length / perPage)), total: all.length };
      } else {
        const res = await ctx.timeEntries.list(filters, page, perPage);
        entries = res.items;
        meta = { page: res.meta?.page ?? page, pages: res.meta?.pages ?? 1, total: res.meta?.total ?? entries.length };
      }
      const names = await ctx.catalog.names();
      const views = entries.map((e) => entryView(e, names, tz));
      const pageSeconds = views.reduce((sum, v) => sum + v.duration_seconds, 0);
      const header = `${meta.total} entr${meta.total === 1 ? 'y' : 'ies'} from ${range.from} to ${range.to} (${tz}), page ${meta.page}/${meta.pages}; ${formatDuration(pageSeconds)} on this page.`;
      const text = [header, ...views.map(entryLine)].join('\n');
      return ok(text, { range, timezone: tz, ...meta, page_hours: toHours(pageSeconds), entries: views });
    }),
  );

  server.registerTool(
    'time_get_entry',
    {
      title: 'Get a time entry',
      description: 'Fetch one FreshBooks time entry by id.',
      inputSchema: { id: z.number().int().positive().describe('Time entry id.'), timezone },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async ({ id, timezone: tzArg }) => {
      const tz = assertTimeZone(tzArg ?? ctx.defaultTimeZone);
      const [entry, names] = await Promise.all([ctx.timeEntries.get(id), ctx.catalog.names()]);
      const view = entryView(entry, names, tz);
      return ok(entryLine(view), { entry: view });
    }),
  );

  server.registerTool(
    'time_create_entry',
    {
      title: 'Log time',
      description:
        'Log hours to FreshBooks. Give a duration plus a client and/or project (names or ids; the client is inferred from the project). ' +
        'Start time: start_time on date (default today) if given; otherwise, for today, the entry ends now; for another date it starts at 09:00 local. ' +
        'Set internal=true for time with no client.',
      inputSchema: {
        duration,
        date: dateString.optional().describe('Work date, YYYY-MM-DD in the chosen timezone. Defaults to today.'),
        start_time: timeString.optional().describe('Local start time, HH:mm (24h).'),
        client: ref('Client').optional(),
        project: ref('Project').optional(),
        service: ref('Service (type of work)').optional(),
        note: z.string().optional().describe('What the work was.'),
        billable: z.boolean().optional().describe('Override billable. FreshBooks decides by default.'),
        internal: z.boolean().optional().describe('Log as internal time with no client.'),
        timezone,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const tz = assertTimeZone(args.timezone ?? ctx.defaultTimeZone);
      const seconds = parseDuration(args.duration);
      const refs = await ctx.catalog.resolveRefs({ client: args.client, project: args.project, service: args.service });
      if (refs.clientId === undefined && !args.internal) {
        throw new ResolutionError('A client (or a project that belongs to one) is required, or set internal=true.');
      }
      const { identityId } = await ctx.http.context();
      const start = startedAt(ctx, tz, seconds, args.date, args.start_time);
      const input: TimeEntryInput = {
        is_logged: true,
        duration: seconds,
        started_at: start.toISOString(),
        note: args.note,
        client_id: refs.clientId ?? null,
        project_id: refs.projectId,
        service_id: refs.serviceId,
        identity_id: identityId,
        ...(args.billable !== undefined ? { billable: args.billable } : {}),
        ...(args.internal ? { internal: true } : {}),
      };
      const created = await ctx.timeEntries.create(input);
      const view = entryView(created, await ctx.catalog.names(), tz);
      return ok(`Logged ${formatDuration(seconds)}: ${entryLine(view)}`, { entry: view });
    }),
  );

  server.registerTool(
    'time_update_entry',
    {
      title: 'Update a time entry',
      description:
        'Change an existing FreshBooks time entry. Only the fields you pass change. date/start_time move the start (unspecified parts keep their current local value). Pass null for project, service or note to clear them.',
      inputSchema: {
        id: z.number().int().positive().describe('Time entry id.'),
        duration: duration.optional(),
        date: dateString.optional().describe('New work date, YYYY-MM-DD.'),
        start_time: timeString.optional().describe('New local start time, HH:mm (24h).'),
        client: ref('Client').optional(),
        project: ref('Project').nullable().optional(),
        service: ref('Service').nullable().optional(),
        note: z.string().nullable().optional(),
        billable: z.boolean().optional(),
        timezone,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const tz = assertTimeZone(args.timezone ?? ctx.defaultTimeZone);
      const existing = await ctx.timeEntries.get(args.id);
      const next = writableFields(existing);
      if (existing.timer?.id) next.timer = { id: existing.timer.id };
      if (args.duration !== undefined) next.duration = parseDuration(args.duration);
      if (args.date || args.start_time) {
        const current = new Date(existing.started_at);
        const [curDate, curTime] = zonedDateTime(current, tz).split(' ') as [string, string];
        next.started_at = zonedToUtc(args.date ?? curDate, args.start_time ?? curTime, tz).toISOString();
      }
      const refs = await ctx.catalog.resolveRefs({
        client: args.client,
        project: args.project ?? undefined,
        service: args.service ?? undefined,
      });
      if (refs.clientId !== undefined) {
        next.client_id = refs.clientId;
        next.internal = false;
      }
      if (args.project === null) next.project_id = null;
      else if (refs.projectId !== undefined) next.project_id = refs.projectId;
      if (args.service === null) next.service_id = null;
      else if (refs.serviceId !== undefined) next.service_id = refs.serviceId;
      if (args.note !== undefined) next.note = args.note;
      if (args.billable !== undefined) next.billable = args.billable;
      const updated = await ctx.timeEntries.update(args.id, next);
      const view = entryView(updated, await ctx.catalog.names(), tz);
      return ok(`Updated: ${entryLine(view)}`, { entry: view });
    }),
  );

  server.registerTool(
    'time_delete_entry',
    {
      title: 'Delete a time entry',
      description: 'Permanently delete a FreshBooks time entry by id.',
      inputSchema: { id: z.number().int().positive().describe('Time entry id.'), timezone },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded(async ({ id, timezone: tzArg }) => {
      const tz = assertTimeZone(tzArg ?? ctx.defaultTimeZone);
      const existing = await ctx.timeEntries.get(id).catch(() => undefined);
      await ctx.timeEntries.remove(id);
      const view = existing ? entryView(existing, await ctx.catalog.names(), tz) : undefined;
      return ok(view ? `Deleted ${entryLine(view)}` : `Deleted time entry #${id}`, { deleted: true, id, entry: view ?? null });
    }),
  );
}
