import { collectPages, type FreshBooksHttp } from './http.js';
import type { Client, PageMeta, Project, Service } from './types.js';

export class LookupsApi {
  constructor(private readonly http: FreshBooksHttp) {}

  async clients(): Promise<Client[]> {
    const { accountId } = await this.http.context();
    return collectPages(async (page) => {
      const res = await this.http.request<{ response: { result: { clients: Client[]; pages: number } } }>(
        'GET',
        `/accounting/account/${accountId}/users/clients`,
        { query: { page, per_page: 100 } },
      );
      const result = res.response.result;
      return { items: result.clients ?? [], pages: result.pages ?? 1 };
    });
  }

  async projects(): Promise<Project[]> {
    const { businessId } = await this.http.context();
    return collectPages(async (page) => {
      const res = await this.http.request<{ projects: Project[]; meta: PageMeta }>(
        'GET',
        `/projects/business/${businessId}/projects`,
        { query: { page, per_page: 100 } },
      );
      return { items: res.projects ?? [], pages: res.meta?.pages ?? 1 };
    });
  }

  async services(): Promise<Service[]> {
    const { businessId } = await this.http.context();
    return collectPages(async (page) => {
      const res = await this.http.request<{ services: Service[]; meta: PageMeta }>(
        'GET',
        `/comments/business/${businessId}/services`,
        { query: { page, per_page: 100 } },
      );
      return { items: res.services ?? [], pages: res.meta?.pages ?? 1 };
    });
  }
}
