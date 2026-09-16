/**
 * Server-side membership.
 *
 * The candidate guide is explicit: "State-changing actions require current
 * server-side authorization. A hidden client button is not authorization." and
 * "possession of a deep link, cached record, biometric unlock, or visible
 * button is not authorization."
 *
 * Every downstream guard in this app compares a request's company against the
 * TOKEN's company. That is sound only if a token cannot be minted for a company
 * the user was never a member of — otherwise the whole chain validates against
 * a premise nobody checked. These tests pin that premise.
 */

import { FakeServer, FakeServerError } from '../fake-server';
import { COMPANIES, MEMBERSHIPS, USERS } from '../seed';

const HOUR = 60 * 60 * 1000;

const DANA = 'usr_dana'; // both companies
const KIM = 'usr_kim'; // Northwind only
const SAM = 'usr_sam'; // Acme only
const NORTHWIND = 'northwind';
const ACME = 'acme';

describe('seed data supports the authorization story', () => {
  it('seeds at least two companies and at least two users', () => {
    // The guide asks for at least two seeded users/roles where authorization
    // matters. Asserted so the demo cannot silently regress to a single tenant.
    expect(COMPANIES.length).toBeGreaterThanOrEqual(2);
    expect(USERS.length).toBeGreaterThanOrEqual(2);
  });

  it('seeds asymmetric memberships, so refusal is demonstrable', () => {
    // If every user belonged to every company, the refusal path would be
    // unreachable and the guard untestable.
    const companiesFor = (u: string) => MEMBERSHIPS.filter((m) => m.userId === u).map((m) => m.companyId);
    expect(companiesFor(DANA).sort()).toEqual([ACME, NORTHWIND]);
    expect(companiesFor(KIM)).toEqual([NORTHWIND]);
    expect(companiesFor(SAM)).toEqual([ACME]);
  });
});

describe('issueToken enforces membership', () => {
  let server: FakeServer;
  beforeEach(() => {
    server = new FakeServer();
  });

  it('issues a token for a company the user belongs to', () => {
    expect(server.issueToken(KIM, NORTHWIND, HOUR)).toMatch(/^tok_/);
    expect(server.issueToken(SAM, ACME, HOUR)).toMatch(/^tok_/);
    expect(server.issueToken(DANA, NORTHWIND, HOUR)).toMatch(/^tok_/);
    expect(server.issueToken(DANA, ACME, HOUR)).toMatch(/^tok_/);
  });

  it.each([
    ['Kim', KIM, ACME],
    ['Sam', SAM, NORTHWIND],
  ])('refuses a token when %s asks for a company they do not belong to', (_who, user, company) => {
    expect(() => server.issueToken(user, company, HOUR)).toThrow(FakeServerError);
    try {
      server.issueToken(user, company, HOUR);
    } catch (e) {
      expect((e as FakeServerError).code).toBe('NOT_A_MEMBER');
      // Permanent: retrying cannot grant a membership the user does not have.
      expect((e as FakeServerError).retryable).toBe(false);
    }
  });

  it('refuses an unknown user outright', () => {
    expect(() => server.issueToken('usr_nobody', NORTHWIND, HOUR)).toThrow(FakeServerError);
  });

  it('does not consume a token number on a refused request', () => {
    // A refusal must not advance server state; otherwise a caller could probe
    // membership by watching the ids move.
    const before = server.issueToken(DANA, NORTHWIND, HOUR);
    try {
      server.issueToken(KIM, ACME, HOUR);
    } catch {
      /* expected */
    }
    const after = server.issueToken(DANA, NORTHWIND, HOUR);

    const n = (t: string) => Number(t.replace('tok_', ''));
    expect(n(after)).toBe(n(before) + 1);
  });

  it('isMember agrees with the seeded memberships', () => {
    expect(server.isMember(KIM, NORTHWIND)).toBe(true);
    expect(server.isMember(KIM, ACME)).toBe(false);
    expect(server.isMember(SAM, ACME)).toBe(true);
    expect(server.isMember(SAM, NORTHWIND)).toBe(false);
  });
});
