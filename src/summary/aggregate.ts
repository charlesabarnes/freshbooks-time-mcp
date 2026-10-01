import type { TimeEntry } from '../freshbooks/types.js';
import { toHours } from '../time/duration.js';
import { weekStart, zonedDate } from '../time/tz.js';

export type GroupBy = 'day' | 'week' | 'client' | 'project' | 'service';

export interface Totals {
  seconds: number;
  hours: number;
  billable_hours: number;
  non_billable_hours: number;
  billed_hours: number;
  unbilled_hours: number;
  entries: number;
}

export interface Bucket extends Totals {
  key: string;
  id?: number | null;
  name: string;
}

export interface Summary {
  from: string;
  to: string;
  timezone: string;
  totals: Totals;
  groups: Partial<Record<GroupBy, Bucket[]>>;
}

export interface NameMaps {
  clients: Map<number, string>;
  projects: Map<number, string>;
  services: Map<number, string>;
}

interface Acc {
  seconds: number;
  billable: number;
  billed: number;
  unbilled: number;
  entries: number;
}

const emptyAcc = (): Acc => ({ seconds: 0, billable: 0, billed: 0, unbilled: 0, entries: 0 });

function add(acc: Acc, entry: TimeEntry): void {
  const seconds = entry.duration ?? 0;
  acc.seconds += seconds;
  acc.entries += 1;
  if (entry.billable) {
    acc.billable += seconds;
    if (entry.billed) acc.billed += seconds;
    else acc.unbilled += seconds;
  }
}

function finish(acc: Acc): Totals {
  return {
    seconds: acc.seconds,
    hours: toHours(acc.seconds),
    billable_hours: toHours(acc.billable),
    non_billable_hours: toHours(acc.seconds - acc.billable),
    billed_hours: toHours(acc.billed),
    unbilled_hours: toHours(acc.unbilled),
    entries: acc.entries,
  };
}

function keyFor(group: GroupBy, entry: TimeEntry, timeZone: string, names: NameMaps): { key: string; id?: number | null; name: string } {
  switch (group) {
    case 'day': {
      const day = zonedDate(new Date(entry.started_at), timeZone);
      return { key: day, name: day };
    }
    case 'week': {
      const week = weekStart(zonedDate(new Date(entry.started_at), timeZone));
      return { key: week, name: `Week of ${week}` };
    }
    case 'client': {
      const id = entry.client_id ?? null;
      if (id === null) return { key: 'internal', id, name: 'Internal (no client)' };
      return { key: String(id), id, name: names.clients.get(id) ?? `Client ${id}` };
    }
    case 'project': {
      const id = entry.project_id ?? null;
      if (id === null) return { key: 'none', id, name: 'No project' };
      return { key: String(id), id, name: names.projects.get(id) ?? `Project ${id}` };
    }
    case 'service': {
      const id = entry.service_id ?? null;
      if (id === null) return { key: 'none', id, name: 'No service' };
      return { key: String(id), id, name: names.services.get(id) ?? `Service ${id}` };
    }
  }
}

export function summarize(
  entries: TimeEntry[],
  options: { from: string; to: string; timeZone: string; groupBy: GroupBy[]; names: NameMaps },
): Summary {
  const counted = entries.filter((e) => e.is_logged !== false && e.active !== false && e.duration);
  const totals = emptyAcc();
  const groups: Partial<Record<GroupBy, Bucket[]>> = {};
  for (const group of options.groupBy) {
    const buckets = new Map<string, { meta: { key: string; id?: number | null; name: string }; acc: Acc }>();
    for (const entry of counted) {
      const meta = keyFor(group, entry, options.timeZone, options.names);
      let bucket = buckets.get(meta.key);
      if (!bucket) buckets.set(meta.key, (bucket = { meta, acc: emptyAcc() }));
      add(bucket.acc, entry);
    }
    const list = [...buckets.values()].map(({ meta, acc }) => ({ ...meta, ...finish(acc) }));
    if (group === 'day' || group === 'week') list.sort((a, b) => a.key.localeCompare(b.key));
    else list.sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
    groups[group] = list;
  }
  for (const entry of counted) add(totals, entry);
  return { from: options.from, to: options.to, timezone: options.timeZone, totals: finish(totals), groups };
}
