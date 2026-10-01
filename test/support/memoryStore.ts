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
  accounts = new Map<number, FreshBooksCredentials>();
  private locks = new Map<number, Promise<unknown>>();

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
  async takeAuthCode(hash: string, clientId: string) {
    const value = this.live(this.codes.get(hash));
    if (!value || value.clientId !== clientId) return undefined;
    this.codes.delete(hash);
    return value;
  }
  async saveToken(t: TokenRecord) {
    this.tokens.set(t.tokenHash, t);
  }
  async getToken(hash: string) {
    return this.live(this.tokens.get(hash));
  }
  async takeToken(hash: string, kind: TokenKind, clientId: string) {
    const value = this.live(this.tokens.get(hash));
    if (!value || value.kind !== kind || value.clientId !== clientId) return undefined;
    this.tokens.delete(hash);
    return value;
  }
  async deleteToken(hash: string) {
    this.tokens.delete(hash);
  }
  get credentials() {
    return [...this.accounts.values()][0];
  }
  async getCredentials(identityId: number) {
    const found = this.accounts.get(identityId);
    return found ? { ...found } : undefined;
  }
  async saveCredentials(c: FreshBooksCredentials) {
    this.accounts.set(c.identityId, { ...c });
  }
  async countCredentials() {
    return this.accounts.size;
  }
  withCredentialsLock<T>(
    identityId: number,
    fn: (current: FreshBooksCredentials | undefined) => Promise<{ save?: FreshBooksCredentials; result: T }>,
  ): Promise<T> {
    const previous = this.locks.get(identityId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const outcome = await fn(await this.getCredentials(identityId));
      if (outcome.save) {
        if (outcome.save.identityId !== identityId) throw new Error('Credential identity mismatch');
        this.accounts.set(identityId, { ...outcome.save });
      }
      return outcome.result;
    });
    this.locks.set(identityId, run.catch(() => {}));
    return run;
  }
  async ping() {}
}
