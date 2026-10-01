import type { Pool, PoolClient } from 'pg';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type {
  AuthCodeRecord,
  FreshBooksCredentials,
  PendingAuthorization,
  Store,
  TokenKind,
  TokenRecord,
} from '../store/types.js';

type Row = Record<string, any>;

const toPending = (r: Row): PendingAuthorization => ({
  state: r.state,
  clientId: r.client_id,
  redirectUri: r.redirect_uri,
  codeChallenge: r.code_challenge,
  clientState: r.client_state ?? undefined,
  scopes: r.scopes,
  resource: r.resource ?? undefined,
  expiresAt: r.expires_at,
});

const toCode = (r: Row): AuthCodeRecord => ({
  codeHash: r.code_hash,
  identityId: Number(r.identity_id),
  clientId: r.client_id,
  redirectUri: r.redirect_uri,
  codeChallenge: r.code_challenge,
  scopes: r.scopes,
  resource: r.resource ?? undefined,
  expiresAt: r.expires_at,
});

const toToken = (r: Row): TokenRecord => ({
  tokenHash: r.token_hash,
  identityId: Number(r.identity_id),
  kind: r.kind,
  clientId: r.client_id,
  scopes: r.scopes,
  resource: r.resource ?? undefined,
  expiresAt: r.expires_at,
});

const toCredentials = (r: Row): FreshBooksCredentials => ({
  identityId: Number(r.identity_id),
  email: r.email,
  businessId: Number(r.business_id),
  accountId: r.account_id,
  businessName: r.business_name ?? undefined,
  accessToken: r.access_token,
  refreshToken: r.refresh_token,
  accessTokenExpiresAt: r.access_token_expires_at,
  redirectUri: r.redirect_uri,
});

const UPSERT_CREDENTIALS = `
  INSERT INTO freshbooks_accounts
    (identity_id, email, business_id, account_id, business_name, access_token, refresh_token, access_token_expires_at, redirect_uri, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
  ON CONFLICT (identity_id) DO UPDATE SET
    email = EXCLUDED.email,
    business_id = EXCLUDED.business_id,
    account_id = EXCLUDED.account_id,
    business_name = EXCLUDED.business_name,
    access_token = EXCLUDED.access_token,
    refresh_token = EXCLUDED.refresh_token,
    access_token_expires_at = EXCLUDED.access_token_expires_at,
    redirect_uri = EXCLUDED.redirect_uri,
    updated_at = now()`;

function credentialParams(c: FreshBooksCredentials): unknown[] {
  return [c.identityId, c.email, c.businessId, c.accountId, c.businessName ?? null, c.accessToken, c.refreshToken, c.accessTokenExpiresAt, c.redirectUri];
}

export class PgStore implements Store {
  constructor(private readonly pool: Pool) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const { rows } = await this.pool.query('SELECT info FROM oauth_clients WHERE client_id = $1', [clientId]);
    return rows[0]?.info;
  }

  async saveClient(client: OAuthClientInformationFull): Promise<void> {
    await this.pool.query(
      'INSERT INTO oauth_clients (client_id, info) VALUES ($1, $2) ON CONFLICT (client_id) DO UPDATE SET info = EXCLUDED.info',
      [client.client_id, JSON.stringify(client)],
    );
  }

  async savePendingAuthorization(p: PendingAuthorization): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_pending_authorizations (state, client_id, redirect_uri, code_challenge, client_state, scopes, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [p.state, p.clientId, p.redirectUri, p.codeChallenge, p.clientState ?? null, p.scopes, p.resource ?? null, p.expiresAt],
    );
  }

  async takePendingAuthorization(state: string): Promise<PendingAuthorization | undefined> {
    const { rows } = await this.pool.query(
      'DELETE FROM oauth_pending_authorizations WHERE state = $1 AND expires_at > now() RETURNING *',
      [state],
    );
    return rows[0] ? toPending(rows[0]) : undefined;
  }

  async saveAuthCode(c: AuthCodeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_auth_codes (code_hash, identity_id, client_id, redirect_uri, code_challenge, scopes, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [c.codeHash, c.identityId, c.clientId, c.redirectUri, c.codeChallenge, c.scopes, c.resource ?? null, c.expiresAt],
    );
  }

  async getAuthCode(codeHash: string): Promise<AuthCodeRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM oauth_auth_codes WHERE code_hash = $1 AND expires_at > now()', [codeHash]);
    return rows[0] ? toCode(rows[0]) : undefined;
  }

  async takeAuthCode(codeHash: string, clientId: string): Promise<AuthCodeRecord | undefined> {
    const { rows } = await this.pool.query(
      'DELETE FROM oauth_auth_codes WHERE code_hash = $1 AND client_id = $2 AND expires_at > now() RETURNING *',
      [codeHash, clientId],
    );
    return rows[0] ? toCode(rows[0]) : undefined;
  }

  async saveToken(t: TokenRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_tokens (token_hash, identity_id, kind, client_id, scopes, resource, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [t.tokenHash, t.identityId, t.kind, t.clientId, t.scopes, t.resource ?? null, t.expiresAt],
    );
  }

  async getToken(tokenHash: string): Promise<TokenRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM oauth_tokens WHERE token_hash = $1 AND expires_at > now()', [tokenHash]);
    return rows[0] ? toToken(rows[0]) : undefined;
  }

  async takeToken(tokenHash: string, kind: TokenKind, clientId: string): Promise<TokenRecord | undefined> {
    const { rows } = await this.pool.query(
      'DELETE FROM oauth_tokens WHERE token_hash = $1 AND kind = $2 AND client_id = $3 AND expires_at > now() RETURNING *',
      [tokenHash, kind, clientId],
    );
    return rows[0] ? toToken(rows[0]) : undefined;
  }

  async deleteToken(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM oauth_tokens WHERE token_hash = $1', [tokenHash]);
  }

  async getCredentials(identityId: number): Promise<FreshBooksCredentials | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM freshbooks_accounts WHERE identity_id = $1', [identityId]);
    return rows[0] ? toCredentials(rows[0]) : undefined;
  }

  async saveCredentials(c: FreshBooksCredentials): Promise<void> {
    await this.pool.query(UPSERT_CREDENTIALS, credentialParams(c));
  }

  async countCredentials(): Promise<number> {
    const { rows } = await this.pool.query('SELECT count(*)::int AS n FROM freshbooks_accounts');
    return rows[0]?.n ?? 0;
  }

  async withCredentialsLock<T>(
    identityId: number,
    fn: (current: FreshBooksCredentials | undefined) => Promise<{ save?: FreshBooksCredentials; result: T }>,
  ): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('freshbooks_account:' || $1::text, 0))", [identityId]);
      const { rows } = await client.query('SELECT * FROM freshbooks_accounts WHERE identity_id = $1', [identityId]);
      const outcome = await fn(rows[0] ? toCredentials(rows[0]) : undefined);
      if (outcome.save && outcome.save.identityId !== identityId) throw new Error('Credential identity mismatch');
      if (outcome.save) await client.query(UPSERT_CREDENTIALS, credentialParams(outcome.save));
      await client.query('COMMIT');
      return outcome.result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
