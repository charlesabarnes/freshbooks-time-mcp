import { describe, expect, it } from 'vitest';
import type { TimeEntry } from '../src/freshbooks/types.js';
import { summarize } from '../src/summary/aggregate.js';
import { parseDuration, formatDuration } from '../src/time/duration.js';
import { resolveDateRange, utcRangeForDates, weekStart, zonedDate, zonedToUtc } from '../src/time/tz.js';

let nextId = 1;
function entry(started_at: string, hours: number, extra: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: nextId++,
    started_at,
    duration: hours * 3600,
    is_logged: true,
    active: true,
    client_id: 1,
    project_id: 5,
    service_id: null,
    note: null,
    billable: true,
    billed: false,
    timer: null,
    ...extra,
  };
}

const names = {
  clients: new Map([[1, 'Acme'], [2, 'Globex']]),
  projects: new Map([[5, 'Website']]),
  services: new Map<number, string>(),
};

describe('timezone helpers', () => {
  it('converts local wall time to UTC across DST', () => {
    expect(zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedToUtc('2026-01-15', '09:00', 'America/New_York').toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(zonedToUtc('2026-03-08', '12:00', 'America/New_York').toISOString()).toBe('2026-03-08T16:00:00.000Z');
  });

  it('builds UTC bounds for whole local days', () => {
    const { start, end } = utcRangeForDates('2026-11-01', '2026-11-01', 'America/New_York');
    expect(start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-02T04:59:59.000Z');
  });

  it('computes the local date and Monday week start', () => {
    expect(zonedDate(new Date('2026-10-01T02:30:00Z'), 'America/New_York')).toBe('2026-09-30');
    expect(zonedDate(new Date('2026-10-01T02:30:00Z'), 'Europe/London')).toBe('2026-10-01');
    expect(weekStart('2026-10-01')).toBe('2026-09-28');
    expect(weekStart('2026-10-04')).toBe('2026-09-28');
    expect(weekStart('2026-09-28')).toBe('2026-09-28');
  });

  it('resolves named periods in the given timezone', () => {
    const now = new Date('2026-10-01T02:00:00Z');
    expect(resolveDateRange({ period: 'today' }, 'America/New_York', now, 'today')).toEqual({ from: '2026-09-30', to: '2026-09-30' });
    expect(resolveDateRange({ period: 'today' }, 'UTC', now, 'today')).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(resolveDateRange({ period: 'last_week' }, 'UTC', now, 'today')).toEqual({ from: '2026-09-21', to: '2026-09-27' });
    expect(resolveDateRange({ period: 'last_month' }, 'UTC', now, 'today')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(resolveDateRange({ from: '2026-09-01' }, 'UTC', now, 'today')).toEqual({ from: '2026-09-01', to: '2026-10-01' });
    expect(() => resolveDateRange({ from: '2026-10-05', to: '2026-10-01' }, 'UTC', now, 'today')).toThrow(/after/);
  });
});

describe('summarize', () => {
  const entries = [
    entry('2026-09-29T14:00:00Z', 2),
    entry('2026-09-30T03:30:00Z', 1, { client_id: 2, project_id: null }),
    entry('2026-09-30T15:00:00Z', 1.5, { billed: true }),
    entry('2026-09-30T18:00:00Z', 0.5, { billable: false }),
    entry('2026-10-01T12:00:00Z', 3, { is_logged: false, duration: null }),
  ];

  it('groups by local day, client and project with billing totals', () => {
    const s = summarize(entries, { from: '2026-09-28', to: '2026-10-01', timeZone: 'America/New_York', groupBy: ['day', 'client', 'project'], names });
    expect(s.totals).toMatchObject({ hours: 5, billable_hours: 4.5, unbilled_hours: 3, billed_hours: 1.5, non_billable_hours: 0.5, entries: 4 });
    expect(s.groups.day!.map((d) => [d.key, d.hours])).toEqual([
      ['2026-09-29', 3],
      ['2026-09-30', 2],
    ]);
    expect(s.groups.client!.map((c) => [c.name, c.hours])).toEqual([
      ['Acme', 4],
      ['Globex', 1],
    ]);
    expect(s.groups.project!.map((p) => [p.name, p.hours])).toEqual([
      ['Website', 4],
      ['No project', 1],
    ]);
  });

  it('shifts day buckets with the timezone', () => {
    const s = summarize(entries, { from: '2026-09-28', to: '2026-10-01', timeZone: 'UTC', groupBy: ['day', 'week'], names });
    expect(s.groups.day!.map((d) => [d.key, d.hours])).toEqual([
      ['2026-09-29', 2],
      ['2026-09-30', 3],
    ]);
    expect(s.groups.week!.map((w) => [w.key, w.hours])).toEqual([['2026-09-28', 5]]);
  });
});

describe('durations', () => {
  it.each([
    [1.5, 5400],
    ['2', 7200],
    ['1:30', 5400],
    ['1h30m', 5400],
    ['1h 15 min', 4500],
    ['90m', 5400],
    ['45 minutes', 2700],
    ['1 hour and 5 minutes', 3900],
  ])('parses %s', (input, seconds) => {
    expect(parseDuration(input)).toBe(seconds);
  });

  it.each(['abc', '0', '-1', '1h tomorrow'])('rejects %s', (input) => {
    expect(() => parseDuration(input)).toThrow();
  });

  it('formats durations', () => {
    expect(formatDuration(5400)).toBe('1h30m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(900)).toBe('15m');
  });
});
