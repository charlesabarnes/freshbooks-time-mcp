import type { Catalog } from '../freshbooks/catalog.js';
import type { FreshBooksHttp } from '../freshbooks/http.js';
import type { LookupsApi } from '../freshbooks/lookups.js';
import type { TimeEntriesApi } from '../freshbooks/timeEntries.js';
import type { TimersApi } from '../freshbooks/timers.js';

export interface ToolContext {
  http: FreshBooksHttp;
  timeEntries: TimeEntriesApi;
  timers: TimersApi;
  lookups: LookupsApi;
  catalog: Catalog;
  defaultTimeZone: string;
  now: () => Date;
}
