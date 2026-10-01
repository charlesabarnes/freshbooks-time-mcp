import { describe, expect, it } from 'vitest';
import { emailAllowed, loadConfig, parseAllowlist } from '../src/config.js';
import { pickBusiness } from '../src/freshbooks/oauth.js';

describe('email allowlist', () => {
  it('refuses everyone when unset or blank', () => {
    expect(parseAllowlist(undefined)).toBeUndefined();
    expect(parseAllowlist(' , ')).toBeUndefined();
    expect(emailAllowed('charles@example.com', undefined)).toBe(false);
    expect(loadConfig({}).allowlist).toBeUndefined();
  });

  it('matches a comma-separated list case-insensitively', () => {
    const list = parseAllowlist(' Charles@Example.com,partner@EXAMPLE.com ');
    expect(emailAllowed('charles@example.com', list)).toBe(true);
    expect(emailAllowed('  PARTNER@example.com ', list)).toBe(true);
    expect(emailAllowed('stranger@example.com', list)).toBe(false);
    expect(emailAllowed('charles@example.com.evil', list)).toBe(false);
    expect(emailAllowed('', list)).toBe(false);
  });

  it('lets anyone with a FreshBooks email in with *', () => {
    const list = parseAllowlist('*');
    expect(emailAllowed('anyone@anywhere.io', list)).toBe(true);
    expect(emailAllowed('', list)).toBe(false);
    expect(emailAllowed(undefined, list)).toBe(false);
    expect(emailAllowed('x@y.z', parseAllowlist('charles@example.com, *'))).toBe(true);
  });

  it('reads ALLOWED_FRESHBOOKS_EMAILS, not the old single-email variable', () => {
    expect(loadConfig({ ALLOWED_FRESHBOOKS_EMAIL: 'a@b.c' }).allowlist).toBeUndefined();
    expect(loadConfig({ ALLOWED_FRESHBOOKS_EMAILS: 'a@b.c' }).allowlist?.emails.has('a@b.c')).toBe(true);
  });
});

describe('pickBusiness', () => {
  const identity = {
    id: 1,
    email: 'a@b.c',
    business_memberships: [
      { business: { id: 10, name: 'First', account_id: 'A1' } },
      { business: { id: 20, name: 'Second', account_id: 'B2' } },
    ],
  };

  it('defaults to the first business', () => {
    expect(pickBusiness(identity).id).toBe(10);
  });

  it('uses the override when the identity belongs to it, else the first', () => {
    expect(pickBusiness(identity, 20).id).toBe(20);
    expect(pickBusiness(identity, 99).id).toBe(10);
  });

  it('fails without any business', () => {
    expect(() => pickBusiness({ ...identity, business_memberships: [] })).toThrow(/no business/);
  });
});
