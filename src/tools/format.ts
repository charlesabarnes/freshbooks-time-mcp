import type { NameMaps } from '../summary/aggregate.js';
import type { TimeEntry } from '../freshbooks/types.js';
import { formatDuration, toHours } from '../time/duration.js';
import { zonedDateTime } from '../time/tz.js';

export interface EntryView {
  id: number;
  started_at: string;
  local_start: string;
  duration_seconds: number;
  hours: number;
  client: { id: number; name: string } | null;
  project: { id: number; name: string } | null;
  service: { id: number; name: string } | null;
  note: string | null;
  billable: boolean;
  billed: boolean;
  internal: boolean;
  is_logged: boolean;
  timer_id: number | null;
}

const named = (map: Map<number, string>, id: number | null | undefined, label: string) =>
  id ? { id, name: map.get(id) ?? `${label} ${id}` } : null;

export function entryView(entry: TimeEntry, names: NameMaps, timeZone: string): EntryView {
  const seconds = entry.duration ?? 0;
  return {
    id: entry.id,
    started_at: entry.started_at,
    local_start: zonedDateTime(new Date(entry.started_at), timeZone),
    duration_seconds: seconds,
    hours: toHours(seconds),
    client: named(names.clients, entry.client_id, 'Client'),
    project: named(names.projects, entry.project_id, 'Project'),
    service: named(names.services, entry.service_id, 'Service'),
    note: entry.note ?? null,
    billable: Boolean(entry.billable),
    billed: Boolean(entry.billed),
    internal: Boolean(entry.internal),
    is_logged: entry.is_logged !== false,
    timer_id: entry.timer?.id ?? null,
  };
}

export function entryLine(v: EntryView): string {
  const who = [v.client?.name ?? (v.internal ? 'Internal' : 'No client'), v.project?.name, v.service?.name].filter(Boolean).join(' / ');
  const status = !v.is_logged ? 'timer' : v.billed ? 'billed' : v.billable ? 'unbilled' : 'non-billable';
  const note = v.note ? ` - ${v.note.length > 80 ? `${v.note.slice(0, 77)}...` : v.note}` : '';
  return `#${v.id} ${v.local_start} ${formatDuration(v.duration_seconds)} | ${who} | ${status}${note}`;
}
