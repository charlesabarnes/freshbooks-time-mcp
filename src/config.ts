export interface FreshBooksAppConfig {
  clientId: string;
  clientSecret: string;
}

export interface EmailAllowlist {
  anyone: boolean;
  emails: ReadonlySet<string>;
}

export interface Config {
  port: number;
  databaseUrl: string | undefined;
  publicUrl: string | undefined;
  defaultTimeZone: string;
  allowlist: EmailAllowlist | undefined;
  businessIdOverride: number | undefined;
  freshbooks: FreshBooksAppConfig | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseAllowlist(value: string | undefined): EmailAllowlist | undefined {
  const entries = (value ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!entries.length) return undefined;
  return { anyone: entries.includes('*'), emails: new Set(entries.filter((e) => e !== '*')) };
}

export function emailAllowed(email: string | undefined, allowlist: EmailAllowlist | undefined): boolean {
  if (!allowlist || !email?.trim()) return false;
  return allowlist.anyone || allowlist.emails.has(email.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const clientId = nonEmpty(env.FRESHBOOKS_CLIENT_ID);
  const clientSecret = nonEmpty(env.FRESHBOOKS_CLIENT_SECRET);
  const businessId = nonEmpty(env.FRESHBOOKS_BUSINESS_ID);
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: nonEmpty(env.DATABASE_URL),
    publicUrl: nonEmpty(env.PUBLIC_URL)?.replace(/\/+$/, ''),
    defaultTimeZone: nonEmpty(env.DEFAULT_TIMEZONE) ?? 'America/New_York',
    allowlist: parseAllowlist(env.ALLOWED_FRESHBOOKS_EMAILS),
    businessIdOverride: businessId ? Number(businessId) : undefined,
    freshbooks: clientId && clientSecret ? { clientId, clientSecret } : undefined,
  };
}

export function authConfigProblems(config: Config): string[] {
  const problems: string[] = [];
  if (!config.freshbooks) problems.push('FRESHBOOKS_CLIENT_ID and FRESHBOOKS_CLIENT_SECRET must be set');
  if (!config.allowlist) problems.push('ALLOWED_FRESHBOOKS_EMAILS must be set (comma-separated emails, or *)');
  return problems;
}
