import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import { registerLookupTools } from './lookups.js';
import { registerSummaryTools } from './summary.js';
import { registerTimeEntryTools } from './timeEntries.js';
import { registerTimerTools } from './timers.js';

export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerTimeEntryTools(server, ctx);
  registerTimerTools(server, ctx);
  registerSummaryTools(server, ctx);
  registerLookupTools(server, ctx);
}
