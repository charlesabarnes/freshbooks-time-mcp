import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { summarize, type Bucket, type GroupBy, type Totals } from '../summary/aggregate.js';
import { assertTimeZone, freshbooksDateTime, resolveDateRange, utcRangeForDates, type Period } from '../time/tz.js';
import type { ToolContext } from './context.js';
import { guarded, ok } from './result.js';
import { rangeShape, ref } from './schemas.js';

const GROUPS = ['day', 'week', 'client', 'project', 'service'] as const;

function totalsLine(t: Totals): string {
  return `${t.hours}h total (billable ${t.billable_hours}h: unbilled ${t.unbilled_hours}h, billed ${t.billed_hours}h; non-billable ${t.non_billable_hours}h)`;
}

function bucketLine(b: Bucket): string {
  return `  ${b.name}: ${b.hours}h (unbilled ${b.unbilled_hours}h, billed ${b.billed_hours}h, non-billable ${b.non_billable_hours}h)`;
}

export function registerSummaryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'time_summary',
    {
      title: 'Time summary',
      description:
        'Total logged hours for a date range (defaults to this week), grouped by day, week (Monday start), client, project and/or service, with billable, unbilled, billed and non-billable totals. Days and weeks follow the chosen timezone.',
      inputSchema: {
        ...rangeShape,
        group_by: z
          .array(z.enum(GROUPS))
          .optional()
          .describe('Breakdowns to include. Default: day, client, project.'),
        client: ref('Client').optional().describe('Only count time for this client (name or id).'),
        project: ref('Project').optional().describe('Only count time for this project (name or id).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const tz = assertTimeZone(args.timezone ?? ctx.defaultTimeZone);
      const range = resolveDateRange({ ...args, period: args.period as Period | undefined }, tz, ctx.now(), 'this_week');
      const { start, end } = utcRangeForDates(range.from, range.to, tz);
      const refs = await ctx.catalog.resolveRefs({ client: args.client, project: args.project });
      const entries = (
        await ctx.timeEntries.listAll({
          startedFrom: freshbooksDateTime(start),
          startedTo: freshbooksDateTime(end),
          clientId: refs.clientId,
        })
      ).filter((e) => refs.projectId === undefined || e.project_id === refs.projectId);
      const groupBy: GroupBy[] = args.group_by?.length ? [...new Set(args.group_by)] : ['day', 'client', 'project'];
      const summary = summarize(entries, { from: range.from, to: range.to, timeZone: tz, groupBy, names: await ctx.catalog.names() });
      const scope = [refs.client?.name, refs.project?.name].filter(Boolean).join(' / ');
      const lines = [`${range.from} to ${range.to} (${tz})${scope ? ` for ${scope}` : ''}: ${totalsLine(summary.totals)}`];
      for (const group of groupBy) {
        const buckets = summary.groups[group] ?? [];
        if (!buckets.length) continue;
        lines.push(`By ${group}:`, ...buckets.map(bucketLine));
      }
      return ok(lines.join('\n'), { ...summary });
    }),
  );
}
