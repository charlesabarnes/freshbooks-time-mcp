export interface TimerRef {
  id: number;
  is_running: boolean | null;
}

export interface TimeEntry {
  id: number;
  identity_id?: number | null;
  is_logged: boolean;
  started_at: string;
  created_at?: string;
  client_id: number | null;
  project_id: number | null;
  service_id: number | null;
  note: string | null;
  active: boolean;
  billable?: boolean;
  billed?: boolean;
  internal?: boolean;
  duration: number | null;
  timer: TimerRef | null;
  [key: string]: unknown;
}

export interface Timer {
  id: number;
  is_running: boolean;
  time_entries: TimeEntry[];
  [key: string]: unknown;
}

export interface Service {
  id: number;
  name: string;
  billable?: boolean;
  vis_state?: number;
  business_id?: number;
}

export interface Project {
  id: number;
  title: string;
  client_id: number | null;
  active: boolean;
  complete: boolean;
  internal?: boolean;
  billing_method?: string | null;
  services?: Service[];
}

export interface Client {
  id: number;
  organization: string | null;
  fname: string | null;
  lname: string | null;
  email: string | null;
  vis_state: number;
}

export interface PageMeta {
  page: number;
  pages: number;
  per_page: number;
  total: number;
  total_logged?: number;
  total_unbilled?: number;
}

export interface Page<T> {
  items: T[];
  meta: PageMeta;
}

export function clientName(client: Pick<Client, 'organization' | 'fname' | 'lname' | 'email' | 'id'>): string {
  const person = [client.fname, client.lname].filter(Boolean).join(' ').trim();
  return client.organization?.trim() || person || client.email || `Client ${client.id}`;
}
