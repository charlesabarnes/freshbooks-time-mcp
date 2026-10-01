export interface FreshBooksAppConfig {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  port: number;
  databaseUrl: string | undefined;
  publicUrl: string | undefined;
  defaultTimeZone: string;
  allowedEmail: string | undefined;
  businessIdOverride: number | undefined;
  freshbooks: FreshBooksAppConfig | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
    allowedEmail: nonEmpty(env.ALLOWED_FRESHBOOKS_EMAIL)?.toLowerCase(),
    businessIdOverride: businessId ? Number(businessId) : undefined,
    freshbooks: clientId && clientSecret ? { clientId, clientSecret } : undefined,
  };
}

export function authConfigProblems(config: Config): string[] {
  const problems: string[] = [];
  if (!config.freshbooks) problems.push('FRESHBOOKS_CLIENT_ID and FRESHBOOKS_CLIENT_SECRET must be set');
  if (!config.allowedEmail) problems.push('ALLOWED_FRESHBOOKS_EMAIL must be set');
  return problems;
}
