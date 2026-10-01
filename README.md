# freshbooks-time-mcp

A remote [MCP](https://modelcontextprotocol.io) server for managing FreshBooks time tracking from Claude (claude.ai, Claude desktop and mobile, Claude Code) or any MCP client that supports OAuth.

Tested and Deployed on [gangway](https://gangway.sh).

## Tools

| Tool | What it does |
| --- | --- |
| `time_list_entries` | Entries for a date range or period, filtered by client, project, service, billable or billed |
| `time_get_entry` | One entry by id |
| `time_create_entry` | Log time (`1.5`, `1:30`, `1h30m`) with date, start, client/project/service by name or id, note |
| `time_update_entry` | Change only the fields given |
| `time_delete_entry` | Delete an entry |
| `timer_current` | The running or paused timer and its elapsed time |
| `timer_start` / `timer_stop` / `timer_discard` | Start or resume, stop and log, or throw away the timer |
| `time_summary` | Hours by day, week, client, project or service, with billable and unbilled totals |
| `lookup_clients` / `lookup_projects` / `lookup_services` | List or search |
| `account_info` | The connected FreshBooks identity and business |

## How auth works

The server is its own OAuth 2.1 authorization server (dynamic client registration and PKCE, per the MCP spec). When a client connects, you sign in with FreshBooks. Only emails on the allowlist get in. Each user's FreshBooks tokens are stored separately in Postgres and refreshed automatically.

## Configuration

| Variable | |
| --- | --- |
| `DATABASE_URL` | Postgres; migrations run at startup |
| `FRESHBOOKS_CLIENT_ID`, `FRESHBOOKS_CLIENT_SECRET` | From a FreshBooks developer app |
| `ALLOWED_FRESHBOOKS_EMAILS` | Comma-separated emails, or `*` for anyone; unset refuses everyone |
| `FRESHBOOKS_BUSINESS_ID` | Optional; defaults to the user's first business |
| `DEFAULT_TIMEZONE` | Optional; default `America/New_York` |
| `PUBLIC_URL` | Optional; derived from the request if unset |
| `PORT` | Default `3000` |

Create a FreshBooks app with redirect URI `https://<your-host>/oauth/callback` and these scopes: `user:profile:read`, `user:time_entries:read`, `user:time_entries:write`, `user:projects:read`, `user:clients:read` and `user:billable_items:read`.

## Running

```sh
npm ci
npm run build
npm start
```

`npm test` runs the unit tests. The Postgres store tests also run when `TEST_DATABASE_URL` is set.

## Connecting

Claude Code:

```sh
claude mcp add --transport http --scope user freshbooks-time https://<your-host>/mcp
```

Then authenticate it from `/mcp`. In claude.ai, add `https://<your-host>/mcp` as a custom connector.

## Notes

FreshBooks doesn't document its timers API. The timer tools follow the endpoints used by FreshBooks' own older clients.
