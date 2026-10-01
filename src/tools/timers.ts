import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { NameMaps } from '../summary/aggregate.js';
import { latestSegment, timerElapsedSeconds } from '../freshbooks/timers.js';
import type { TimeEntryInput } from '../freshbooks/timeEntries.js';
import type { TimeEntry, Timer } from '../freshbooks/types.js';
import { formatDuration, toHours } from '../time/duration.js';
import { assertTimeZone, zonedDateTime } from '../time/tz.js';
import type { ToolContext } from './context.js';
import { entryView } from './format.js';
import { guarded, ok } from './result.js';
import { ref, timezone } from './schemas.js';

function timerView(timer: Timer, names: NameMaps, tz: string, now: Date) {
  const last = latestSegment(timer);
  const first = timer.time_entries[0];
  const view = last ? entryView(last, names, tz) : undefined;
  return {
    id: timer.id,
    running: Boolean(timer.is_running),
    elapsed_seconds: timerElapsedSeconds(timer, now),
    elapsed_hours: toHours(timerElapsedSeconds(timer, now)),
    started_at: first?.started_at ?? null,
    local_start: first ? zonedDateTime(new Date(first.started_at), tz) : null,
    segments: timer.time_entries.length,
    client: view?.client ?? null,
    project: view?.project ?? null,
    service: view?.service ?? null,
    note: view?.note ?? null,
    billable: view?.billable ?? null,
  };
}

function describeTimer(v: ReturnType<typeof timerView>): string {
  const who = [v.client?.name, v.project?.name, v.service?.name].filter(Boolean).join(' / ') || 'no client yet';
  const state = v.running ? 'Running' : 'Paused';
  return `${state} timer #${v.id}: ${formatDuration(v.elapsed_seconds)} since ${v.local_start} | ${who}${v.note ? ` - ${v.note}` : ''}`;
}

const detailsShape = {
  client: ref('Client').optional(),
  project: ref('Project').optional(),
  service: ref('Service (type of work)').optional(),
  note: z.string().optional().describe('What you are working on.'),
  billable: z.boolean().optional(),
};

async function resolveDetails(ctx: ToolContext, args: { client?: string | number; project?: string | number; service?: string | number; note?: string; billable?: boolean }) {
  const refs = await ctx.catalog.resolveRefs({ client: args.client, project: args.project, service: args.service });
  const fields: Partial<TimeEntry> = {};
  if (refs.clientId !== undefined) fields.client_id = refs.clientId;
  if (refs.projectId !== undefined) fields.project_id = refs.projectId;
  if (refs.serviceId !== undefined) fields.service_id = refs.serviceId;
  if (args.note !== undefined) fields.note = args.note;
  if (args.billable !== undefined) fields.billable = args.billable;
  return fields;
}

export function registerTimerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'timer_current',
    {
      title: 'Current timer',
      description: 'Show the FreshBooks timer that is running or paused, with elapsed time and what it is tracking.',
      inputSchema: { timezone },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async ({ timezone: tzArg }) => {
      const tz = assertTimeZone(tzArg ?? ctx.defaultTimeZone);
      const timer = await ctx.timers.current();
      if (!timer) return ok('No timer is running.', { timer: null });
      const view = timerView(timer, await ctx.catalog.names(), tz, ctx.now());
      return ok(describeTimer(view), { timer: view });
    }),
  );

  server.registerTool(
    'timer_start',
    {
      title: 'Start timer',
      description:
        'Start a FreshBooks timer now, optionally for a client/project/service (names or ids) with a note. Resumes a paused timer instead of starting a second one; fails if a timer is already running.',
      inputSchema: { ...detailsShape, timezone },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const tz = assertTimeZone(args.timezone ?? ctx.defaultTimeZone);
      const existing = await ctx.timers.current();
      if (existing?.is_running) {
        const view = timerView(existing, await ctx.catalog.names(), tz, ctx.now());
        throw new Error(`A timer is already running. ${describeTimer(view)}. Stop or discard it first.`);
      }
      const details = await resolveDetails(ctx, args);
      const { identityId } = await ctx.http.context();
      const carried = existing ? latestSegment(existing) : undefined;
      const input: TimeEntryInput = {
        is_logged: false,
        started_at: ctx.now().toISOString(),
        identity_id: identityId,
        ...(carried
          ? {
              client_id: carried.client_id,
              project_id: carried.project_id,
              service_id: carried.service_id,
              note: carried.note,
              ...(carried.billable !== undefined ? { billable: carried.billable } : {}),
              timer: { id: existing!.id },
            }
          : {}),
        ...(details as TimeEntryInput),
      };
      await ctx.timeEntries.create(input);
      const timer = await ctx.timers.current();
      if (!timer) return ok('Timer started.', { timer: null, resumed: Boolean(existing) });
      const view = timerView(timer, await ctx.catalog.names(), tz, ctx.now());
      return ok(`${existing ? 'Resumed' : 'Started'}. ${describeTimer(view)}`, { timer: view, resumed: Boolean(existing) });
    }),
  );

  server.registerTool(
    'timer_stop',
    {
      title: 'Stop timer and log time',
      description:
        'Stop the current FreshBooks timer and log its time as a time entry. Optionally set or change the client/project/service/note being logged.',
      inputSchema: { ...detailsShape, timezone },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const tz = assertTimeZone(args.timezone ?? ctx.defaultTimeZone);
      const timer = await ctx.timers.current();
      if (!timer) throw new Error('No timer is running.');
      const details = await resolveDetails(ctx, args);
      const now = ctx.now();
      const elapsed = timerElapsedSeconds(timer, now);
      const stopped = await ctx.timers.stop(timer, now, details);
      const names = await ctx.catalog.names();
      const entries = (stopped?.time_entries ?? []).map((e) => entryView(e, names, tz));
      const before = timerView(timer, names, tz, now);
      const last = entries.at(-1);
      const label = [last?.client?.name ?? before.client?.name, last?.project?.name ?? before.project?.name].filter(Boolean).join(' / ');
      return ok(`Stopped timer #${timer.id} and logged ${formatDuration(elapsed)}${label ? ` to ${label}` : ''}.`, {
        timer_id: timer.id,
        logged_seconds: elapsed,
        logged_hours: toHours(elapsed),
        entries,
      });
    }),
  );

  server.registerTool(
    'timer_discard',
    {
      title: 'Discard timer',
      description: 'Delete the current FreshBooks timer without logging any of its time.',
      inputSchema: { timezone },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded(async ({ timezone: tzArg }) => {
      const tz = assertTimeZone(tzArg ?? ctx.defaultTimeZone);
      const timer = await ctx.timers.current();
      if (!timer) return ok('No timer to discard.', { discarded: false });
      const view = timerView(timer, await ctx.catalog.names(), tz, ctx.now());
      await ctx.timers.discard(timer.id);
      return ok(`Discarded ${describeTimer(view)}`, { discarded: true, timer: view });
    }),
  );
}
