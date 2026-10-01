import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type {
  AuthCodeRecord,
  FreshBooksCredentials,
  PendingAuthorization,
  Store,
  TokenKind,
  TokenRecord,
} from '../../src/store/types.js';

export class MemoryStore implements Store {
  clients = new Map<string, OAuthClientInformationFull>();
  pending = new Map<string, PendingAuthorization>();
  codes = new Map<string, AuthCodeRecord>();
  tokens = new Map<string, TokenRecord>();
  credentials: FreshBooksCredentials | undefined;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private live<T extends { expiresAt: Date }>(value: T | undefined): T | undefined {
    return value && value.expiresAt > this.now() ? value : undefined;
  }

  async getClient(id: string) {
    return this.clients.get(id);
  }
  async saveClient(client: OAuthClientInformationFull) {
    this.clients.set(client.client_id, client);
  }
  async savePendingAuthorization(p: PendingAuthorization) {
    this.pending.set(p.state, p);
  }
  async takePendingAuthorization(state: string) {
    const value = this.live(this.pending.get(state));
    this.pending.delete(state);
    return value;
  }
  async saveAuthCode(c: AuthCodeRecord) {
    this.codes.set(c.codeHash, c);
  }
  async getAuthCode(hash: string) {
    return this.live(this.codes.get(hash));
  }
  async takeAuthCode(hash: string) {
    const value = this.live(this.codes.get(hash));
    this.codes.delete(hash);
    return value;
  }
  async saveToken(t: TokenRecord) {
    this.tokens.set(t.tokenHash, t);
  }
  async getToken(hash: string) {
    return this.live(this.tokens.get(hash));
  }
  async takeToken(hash: string, kind: TokenKind) {
    const value = this.live(this.tokens.get(hash));
    if (!value || value.kind !== kind) return undefined;
    this.tokens.delete(hash);
    return value;
  }
  async deleteToken(hash: string) {
    this.tokens.delete(hash);
  }
  async getCredentials() {
    return this.credentials ? { ...this.credentials } : undefined;
  }
  async saveCredentials(c: FreshBooksCredentials) {
    this.credentials = { ...c };
  }
  withCredentialsLock<T>(fn: (current: FreshBooksCredentials | undefined) => Promise<{ save?: FreshBooksCredentials; result: T }>): Promise<T> {
    const run = this.lock.then(async () => {
      const outcome = await fn(this.credentials ? { ...this.credentials } : undefined);
      if (outcome.save) this.credentials = { ...outcome.save };
      return outcome.result;
    });
    this.lock = run.catch(() => {});
    return run;
  }
  async ping() {}
}
