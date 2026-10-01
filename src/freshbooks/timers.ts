import type { FreshBooksHttp } from './http.js';
import type { TimeEntry, Timer } from './types.js';

const base = (businessId: number) => `/timetracking/business/${businessId}/timers`;

const STRIPPED_FIELDS = ['active', 'identity_id', 'created_at'];

export function timerElapsedSeconds(timer: Timer, now: Date): number {
  let total = 0;
  for (const entry of timer.time_entries) {
    if (entry.duration) total += entry.duration;
    else total += Math.max(0, Math.round((now.getTime() - Date.parse(entry.started_at)) / 1000));
  }
  return total;
}

export function activeSegment(timer: Timer): TimeEntry | undefined {
  return timer.time_entries.find((e) => !e.duration) ?? timer.time_entries.at(-1);
}

export function latestSegment(timer: Timer): TimeEntry | undefined {
  return timer.time_entries.at(-1);
}

export function stopPayload(timer: Timer, now: Date, overrides: Partial<TimeEntry> = {}): { timer: { time_entries: Record<string, unknown>[] } } {
  const entries = timer.time_entries.map((entry, index) => {
    const copy: Record<string, unknown> = { ...entry };
    for (const field of STRIPPED_FIELDS) delete copy[field];
    if (!entry.duration) {
      copy.duration = Math.max(1, Math.round((now.getTime() - Date.parse(entry.started_at)) / 1000));
    }
    if (index === timer.time_entries.length - 1) {
      copy.timer = { id: timer.id };
      Object.assign(copy, overrides);
    }
    return copy;
  });
  return { timer: { time_entries: entries } };
}

export class TimersApi {
  constructor(private readonly http: FreshBooksHttp) {}

  async list(): Promise<Timer[]> {
    const { businessId } = await this.http.context();
    const res = await this.http.request<{ timers: Timer[] }>('GET', base(businessId));
    return res?.timers ?? [];
  }

  async current(): Promise<Timer | undefined> {
    const timers = await this.list();
    return timers.find((t) => t.is_running) ?? timers[0];
  }

  async stop(timer: Timer, now: Date, overrides: Partial<TimeEntry> = {}): Promise<Timer | undefined> {
    const { businessId } = await this.http.context();
    const res = await this.http.request<{ timer?: Timer }>('PUT', `${base(businessId)}/${timer.id}`, {
      body: stopPayload(timer, now, overrides),
    });
    return res?.timer;
  }

  async discard(timerId: number): Promise<void> {
    const { businessId } = await this.http.context();
    await this.http.request('DELETE', `${base(businessId)}/${timerId}`);
  }
}
