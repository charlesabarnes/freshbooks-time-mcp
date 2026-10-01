import type { CredentialManager } from './credentials.js';
import { FreshBooksApiError, extractErrorMessage } from './errors.js';

export const FRESHBOOKS_API_BASE = 'https://api.freshbooks.com';

export type QueryValue = string | number | boolean | undefined | null;
export type Query = Record<string, QueryValue | QueryValue[]>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
}

export interface FreshBooksContext {
  businessId: number;
  accountId: string;
  identityId: number;
  email: string;
  businessName: string | undefined;
}

export function buildQuery(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export class FreshBooksHttp {
  constructor(
    private readonly credentials: CredentialManager,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = FRESHBOOKS_API_BASE,
  ) {}

  async context(): Promise<FreshBooksContext> {
    const c = await this.credentials.current();
    return {
      businessId: c.businessId,
      accountId: c.accountId,
      identityId: c.identityId,
      email: c.email,
      businessName: c.businessName,
    };
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    let creds = await this.credentials.current();
    let res = await this.send(method, path, options, creds.accessToken);
    if (res.status === 401) {
      creds = await this.credentials.refresh(creds.accessToken);
      res = await this.send(method, path, options, creds.accessToken);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const detail = extractErrorMessage(json) ?? res.statusText;
      throw new FreshBooksApiError(res.status, `FreshBooks ${method} ${path} failed (${res.status}): ${detail}`, json);
    }
    const accountingErrors = (json as any)?.response?.errors;
    if (Array.isArray(accountingErrors) && accountingErrors.length) {
      throw new FreshBooksApiError(res.status, `FreshBooks ${method} ${path} failed: ${extractErrorMessage(json)}`, json);
    }
    return json as T;
  }

  private send(method: string, path: string, options: RequestOptions, token: string): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    return this.fetchImpl(`${this.baseUrl}${path}${buildQuery(options.query)}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }
}

export async function collectPages<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; pages: number }>,
  maxPages = 50,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { items, pages } = await fetchPage(page);
    all.push(...items);
    if (page >= pages || items.length === 0) break;
  }
  return all;
}
