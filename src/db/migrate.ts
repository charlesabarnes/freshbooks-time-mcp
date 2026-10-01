import type { Pool } from 'pg';

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    info JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_pending_authorizations (
    state TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    client_state TEXT,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    resource TEXT,
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code_hash TEXT PRIMARY KEY,
    identity_id BIGINT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    resource TEXT,
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    identity_id BIGINT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    client_id TEXT NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    resource TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS oauth_tokens_expires_at_idx ON oauth_tokens (expires_at)`,
  `CREATE INDEX IF NOT EXISTS oauth_tokens_identity_idx ON oauth_tokens (identity_id)`,
  `CREATE TABLE IF NOT EXISTS freshbooks_accounts (
    identity_id BIGINT PRIMARY KEY,
    email TEXT NOT NULL,
    business_id BIGINT NOT NULL,
    account_id TEXT NOT NULL,
    business_name TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    access_token_expires_at TIMESTAMPTZ NOT NULL,
    redirect_uri TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
];

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(724001)');
    for (const statement of MIGRATIONS) await client.query(statement);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function purgeExpired(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM oauth_pending_authorizations WHERE expires_at < now()');
  await pool.query('DELETE FROM oauth_auth_codes WHERE expires_at < now()');
  await pool.query('DELETE FROM oauth_tokens WHERE expires_at < now()');
}
