import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandler } from 'express';
import { Catalog } from '../freshbooks/catalog.js';
import type { CredentialManager } from '../freshbooks/credentials.js';
import { FreshBooksHttp } from '../freshbooks/http.js';
import { LookupsApi } from '../freshbooks/lookups.js';
import { TimeEntriesApi } from '../freshbooks/timeEntries.js';
import { TimersApi } from '../freshbooks/timers.js';
import { registerTools } from '../tools/index.js';

export const SERVER_INFO = { name: 'freshbooks-time', version: '1.0.0' };

export interface McpDeps {
  http: FreshBooksHttp;
  defaultTimeZone: string;
  now?: () => Date;
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Manage FreshBooks tracked time: log, list, edit and delete time entries, run a live timer, and summarize hours. ' +
      'Clients, projects and services can be given by name or id. Dates are interpreted in the given timezone (default ' +
      `${deps.defaultTimeZone}).`,
  });
  const lookups = new LookupsApi(deps.http);
  registerTools(server, {
    http: deps.http,
    timeEntries: new TimeEntriesApi(deps.http),
    timers: new TimersApi(deps.http),
    lookups,
    catalog: new Catalog(lookups),
    defaultTimeZone: deps.defaultTimeZone,
    now: deps.now ?? (() => new Date()),
  });
  return server;
}

export interface McpHandlerDeps {
  credentials: CredentialManager;
  fetchImpl: typeof fetch;
  defaultTimeZone: string;
  now?: () => Date;
}

export function mcpHandler(deps: McpHandlerDeps): RequestHandler {
  return async (req, res) => {
    const identityId = Number(req.auth?.extra?.identityId);
    if (!Number.isSafeInteger(identityId) || identityId <= 0) {
      res.status(401).json({ error: 'invalid_token', error_description: 'Token is not bound to a FreshBooks identity' });
      return;
    }
    const http = new FreshBooksHttp(deps.credentials, identityId, deps.fetchImpl);
    const server = buildMcpServer({ http, defaultTimeZone: deps.defaultTimeZone, now: deps.now });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request failed', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };
}

export const methodNotAllowed: RequestHandler = (_req, res) => {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST.' }, id: null });
};
