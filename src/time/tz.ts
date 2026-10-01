export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

export function assertTimeZone(timeZone: string): string {
  try {
    formatter(timeZone);
  } catch {
    throw new Error(`Unknown timezone "${timeZone}". Use an IANA name like America/New_York.`);
  }
  return timeZone;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function zonedDate(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function zonedDateTime(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  if (!DATE_RE.test(date)) throw new Error(`Invalid date "${date}", expected YYYY-MM-DD`);
  const match = TIME_RE.exec(time);
  if (!match) throw new Error(`Invalid time "${time}", expected HH:mm`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, Number(match[1]), Number(match[2]), Number(match[3] ?? 0));
  const first = guess - offsetMs(new Date(guess), timeZone);
  const second = guess - offsetMs(new Date(first), timeZone);
  return new Date(second);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const result = new Date(Date.UTC(y, m - 1, d + days));
  return result.toISOString().slice(0, 10);
}

export function weekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

export function utcRangeForDates(from: string, to: string, timeZone: string): { start: Date; end: Date } {
  const start = zonedToUtc(from, '00:00', timeZone);
  const end = new Date(zonedToUtc(addDays(to, 1), '00:00', timeZone).getTime() - 1000);
  return { start, end };
}

export function freshbooksDateTime(date: Date): string {
  return date.toISOString().slice(0, 19);
}

export type Period = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'last_7_days' | 'last_30_days';

export const PERIODS: readonly Period[] = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'last_7_days',
  'last_30_days',
];

export function resolveDateRange(
  input: { period?: Period; from?: string; to?: string },
  timeZone: string,
  now: Date,
  fallback: Period,
): { from: string; to: string } {
  const today = zonedDate(now, timeZone);
  if (input.from || input.to) {
    const from = input.from ?? input.to!;
    const to = input.to ?? today;
    for (const value of [from, to]) {
      if (!DATE_RE.test(value)) throw new Error(`Invalid date "${value}", expected YYYY-MM-DD`);
    }
    if (from > to) throw new Error(`"from" (${from}) is after "to" (${to})`);
    return { from, to };
  }
  const period = input.period ?? fallback;
  const monthStart = `${today.slice(0, 8)}01`;
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'this_week':
      return { from: weekStart(today), to: today };
    case 'last_week': {
      const start = addDays(weekStart(today), -7);
      return { from: start, to: addDays(start, 6) };
    }
    case 'this_month':
      return { from: monthStart, to: today };
    case 'last_month': {
      const end = addDays(monthStart, -1);
      return { from: `${end.slice(0, 8)}01`, to: end };
    }
    case 'last_7_days':
      return { from: addDays(today, -6), to: today };
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
  }
}
