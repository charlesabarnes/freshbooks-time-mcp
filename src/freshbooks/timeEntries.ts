import { collectPages, type FreshBooksHttp } from './http.js';
import type { Page, PageMeta, TimeEntry } from './types.js';

export interface TimeEntryFilters {
  startedFrom?: string;
  startedTo?: string;
  clientId?: number;
  billable?: boolean;
  billed?: boolean;
  includeUnlogged?: boolean;
}

export interface TimeEntryInput {
  is_logged?: boolean;
  started_at?: string;
  duration?: number | null;
  note?: string | null;
  client_id?: number | null;
  project_id?: number | null;
  service_id?: number | null;
  billable?: boolean;
  internal?: boolean;
  identity_id?: number;
  timer?: { id: number } | null;
}

export const WRITABLE_FIELDS = [
  'is_logged',
  'started_at',
  'duration',
  'note',
  'client_id',
  'project_id',
  'service_id',
  'billable',
  'internal',
] as const;

const base = (businessId: number) => `/timetracking/business/${businessId}/time_entries`;

function filterQuery(f: TimeEntryFilters) {
  return {
    started_from: f.startedFrom,
    started_to: f.startedTo,
    client_id: f.clientId,
    billable: f.billable,
    billed: f.billed,
    include_unlogged: f.includeUnlogged,
  };
}

export class TimeEntriesApi {
  constructor(private readonly http: FreshBooksHttp) {}

  async list(filters: TimeEntryFilters, page = 1, perPage = 50): Promise<Page<TimeEntry>> {
    const { businessId } = await this.http.context();
    const res = await this.http.request<{ time_entries: TimeEntry[]; meta: PageMeta }>('GET', base(businessId), {
      query: { ...filterQuery(filters), page, per_page: Math.min(perPage, 100) },
    });
    return { items: res.time_entries ?? [], meta: res.meta };
  }

  listAll(filters: TimeEntryFilters): Promise<TimeEntry[]> {
    return collectPages(async (page) => {
      const res = await this.list(filters, page, 100);
      return { items: res.items, pages: res.meta?.pages ?? 1 };
    });
  }

  async get(id: number): Promise<TimeEntry> {
    const { businessId } = await this.http.context();
    const res = await this.http.request<{ time_entry: TimeEntry }>('GET', `${base(businessId)}/${id}`);
    return res.time_entry;
  }

  async create(input: TimeEntryInput): Promise<TimeEntry> {
    const { businessId } = await this.http.context();
    const res = await this.http.request<{ time_entry: TimeEntry }>('POST', base(businessId), { body: { time_entry: input } });
    return res.time_entry;
  }

  async update(id: number, input: TimeEntryInput): Promise<TimeEntry> {
    const { businessId } = await this.http.context();
    const res = await this.http.request<{ time_entry: TimeEntry }>('PUT', `${base(businessId)}/${id}`, {
      body: { time_entry: input },
    });
    return res.time_entry;
  }

  async remove(id: number): Promise<void> {
    const { businessId } = await this.http.context();
    await this.http.request('DELETE', `${base(businessId)}/${id}`);
  }
}

export function writableFields(entry: TimeEntry): TimeEntryInput {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_FIELDS) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  return out as TimeEntryInput;
}
