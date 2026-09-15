/**
 * Deterministic seed data for the in-process fake backend.
 *
 * Everything here is hardcoded: fixed ids, fixed ISO instants, no Date.now(),
 * no Math.random(). The same process start always produces the same rows, which
 * is what lets the matching tests assert on exact candidate sets.
 *
 * The transaction rows are chosen adversarially. A matcher that "works" on
 * well-separated data proves nothing, so every company gets rows that are
 * close but not identical in each of the ways that actually break naive
 * matching:
 *
 *   - same merchant, amount off by exactly ONE minor unit  (proves the matcher
 *     compares integer minor units, not rounded floats)
 *   - same merchant, amount off by a few dollars           (near miss)
 *   - same merchant + amount, dates one day apart          (date tolerance)
 *   - same amount + same date, different merchant          (merchant matters)
 *   - a zero-decimal currency row (JPY)                    (2400 means Y2,400)
 *   - a genuinely ambiguous near-duplicate pair            (two rows a matcher
 *     cannot separate; the app must ask a human rather than guess)
 */

import type { Company, Transaction, User } from '../domain/types';

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

export const COMPANIES: Company[] = [
  { id: 'northwind', name: 'Northwind Traders' },
  { id: 'acme', name: 'Acme Corporation' },
];

export const USERS: User[] = [
  // Belongs to BOTH companies. This is the user that makes the company-switch
  // invariant testable: switching is a legal thing for them to do, so the app
  // cannot defend the boundary by simply forbidding the switch.
  { id: 'usr_dana', email: 'dana@example.com', displayName: 'Dana Reyes' },
  { id: 'usr_kim', email: 'kim@northwind.example', displayName: 'Kim Alvarez' },
  { id: 'usr_sam', email: 'sam@acme.example', displayName: 'Sam Okafor' },
];

/**
 * Which user may authenticate into which company. The fake server does not
 * enforce membership when issuing a token (tokens are minted by test/demo
 * code), but the UI needs this to render a company switcher.
 */
export interface Membership {
  readonly userId: string;
  readonly companyId: string;
}

export const MEMBERSHIPS: Membership[] = [
  { userId: 'usr_dana', companyId: 'northwind' },
  { userId: 'usr_dana', companyId: 'acme' },
  { userId: 'usr_kim', companyId: 'northwind' },
  { userId: 'usr_sam', companyId: 'acme' },
];

/**
 * Merchant names that appear in seeded transactions.
 *
 * Exported because the fake OCR draws from this list on purpose: if OCR only
 * ever invented merchants that no transaction used, the matching screen would
 * never have a real candidate to show.
 */
export const SEED_MERCHANT_NAMES: string[] = [
  'Blue Bottle Coffee',
  'Sunrise Diner',
  'Harborview Parking',
  'Otemachi Ramen',
  'City Cab Co',
  'Globex Office Supply',
  'Initech Cafeteria',
  'Vandelay Imports',
  'Shinjuku Izakaya',
  'Metro Transit Authority',
];

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Fresh copies of the seeded card transactions.
 *
 * Returns new objects on every call so that a caller which tracks match state
 * (the fake server does) can never corrupt the seed for the next reset().
 *
 * `occurredAt` is an Instant — the moment the card network cleared the charge.
 * It is deliberately NOT the same thing as the DateOnly printed on a receipt,
 * and nothing here converts between them. txn_nw_07 exists to make that
 * concrete: 2026-08-14T02:30:00.000Z is 2026-08-14 in Tokyo but 2026-08-13 in
 * New York, so "the date of this transaction" is not a question with one
 * answer.
 */
export function seedTransactions(): Transaction[] {
  return [
    // --- Northwind -------------------------------------------------------
    // Baseline.
    {
      id: 'txn_nw_01',
      companyId: 'northwind',
      merchant: 'Blue Bottle Coffee',
      amountMinorUnits: 4250, // $42.50
      currency: 'USD',
      occurredAt: '2026-08-11T15:04:00.000Z',
      matchedReceiptId: null,
    },
    // Same merchant, ONE minor unit more. A float-based comparison with any
    // tolerance at all will happily confuse this with txn_nw_01.
    {
      id: 'txn_nw_02',
      companyId: 'northwind',
      merchant: 'Blue Bottle Coffee',
      amountMinorUnits: 4251, // $42.51
      currency: 'USD',
      occurredAt: '2026-08-11T15:06:00.000Z',
      matchedReceiptId: null,
    },
    // Same merchant, three dollars apart.
    {
      id: 'txn_nw_03',
      companyId: 'northwind',
      merchant: 'Blue Bottle Coffee',
      amountMinorUnits: 4550, // $45.50
      currency: 'USD',
      occurredAt: '2026-08-11T15:09:00.000Z',
      matchedReceiptId: null,
    },
    // Same merchant + same amount as txn_nw_05, one calendar day earlier.
    {
      id: 'txn_nw_04',
      companyId: 'northwind',
      merchant: 'Sunrise Diner',
      amountMinorUnits: 7899, // $78.99
      currency: 'USD',
      occurredAt: '2026-08-12T18:20:00.000Z',
      matchedReceiptId: null,
    },
    {
      id: 'txn_nw_05',
      companyId: 'northwind',
      merchant: 'Sunrise Diner',
      amountMinorUnits: 7899,
      currency: 'USD',
      occurredAt: '2026-08-13T18:20:00.000Z',
      matchedReceiptId: null,
    },
    // Same amount and same instant as txn_nw_04, different merchant.
    {
      id: 'txn_nw_06',
      companyId: 'northwind',
      merchant: 'Harborview Parking',
      amountMinorUnits: 7899,
      currency: 'USD',
      occurredAt: '2026-08-12T18:20:00.000Z',
      matchedReceiptId: null,
    },
    // Zero-decimal currency: 2400 minor units is Y2,400, NOT Y24.00. Any code
    // that divides by 100 to display money is wrong here.
    {
      id: 'txn_nw_07',
      companyId: 'northwind',
      merchant: 'Otemachi Ramen',
      amountMinorUnits: 2400,
      currency: 'JPY',
      occurredAt: '2026-08-14T02:30:00.000Z',
      matchedReceiptId: null,
    },
    // The ambiguous pair: same merchant, same amount, same currency, two
    // minutes apart. Two cab rides, or one ride billed twice — the server
    // cannot tell, and neither can the matcher. It must surface both.
    {
      id: 'txn_nw_08',
      companyId: 'northwind',
      merchant: 'City Cab Co',
      amountMinorUnits: 1875, // $18.75
      currency: 'USD',
      occurredAt: '2026-08-15T22:41:00.000Z',
      matchedReceiptId: null,
    },
    {
      id: 'txn_nw_09',
      companyId: 'northwind',
      merchant: 'City Cab Co',
      amountMinorUnits: 1875,
      currency: 'USD',
      occurredAt: '2026-08-15T22:43:00.000Z',
      matchedReceiptId: null,
    },

    // --- Acme ------------------------------------------------------------
    {
      id: 'txn_ac_01',
      companyId: 'acme',
      merchant: 'Globex Office Supply',
      amountMinorUnits: 12999, // $129.99
      currency: 'USD',
      occurredAt: '2026-08-03T13:00:00.000Z',
      matchedReceiptId: null,
    },
    // One minor unit apart from txn_ac_01.
    {
      id: 'txn_ac_02',
      companyId: 'acme',
      merchant: 'Globex Office Supply',
      amountMinorUnits: 13000, // $130.00
      currency: 'USD',
      occurredAt: '2026-08-03T13:02:00.000Z',
      matchedReceiptId: null,
    },
    // Five dollars apart from txn_ac_01.
    {
      id: 'txn_ac_03',
      companyId: 'acme',
      merchant: 'Globex Office Supply',
      amountMinorUnits: 12499, // $124.99
      currency: 'USD',
      occurredAt: '2026-08-03T13:05:00.000Z',
      matchedReceiptId: null,
    },
    {
      id: 'txn_ac_04',
      companyId: 'acme',
      merchant: 'Initech Cafeteria',
      amountMinorUnits: 3300, // $33.00
      currency: 'USD',
      occurredAt: '2026-08-05T12:15:00.000Z',
      matchedReceiptId: null,
    },
    // One day after txn_ac_04, otherwise identical.
    {
      id: 'txn_ac_05',
      companyId: 'acme',
      merchant: 'Initech Cafeteria',
      amountMinorUnits: 3300,
      currency: 'USD',
      occurredAt: '2026-08-06T12:15:00.000Z',
      matchedReceiptId: null,
    },
    // Same amount and instant as txn_ac_04, different merchant.
    {
      id: 'txn_ac_06',
      companyId: 'acme',
      merchant: 'Vandelay Imports',
      amountMinorUnits: 3300,
      currency: 'USD',
      occurredAt: '2026-08-05T12:15:00.000Z',
      matchedReceiptId: null,
    },
    {
      id: 'txn_ac_07',
      companyId: 'acme',
      merchant: 'Shinjuku Izakaya',
      amountMinorUnits: 8800, // Y8,800
      currency: 'JPY',
      occurredAt: '2026-08-07T11:30:00.000Z',
      matchedReceiptId: null,
    },
    // Acme's ambiguous pair: two identical fares, three minutes apart.
    {
      id: 'txn_ac_08',
      companyId: 'acme',
      merchant: 'Metro Transit Authority',
      amountMinorUnits: 275, // $2.75
      currency: 'USD',
      occurredAt: '2026-08-09T08:01:00.000Z',
      matchedReceiptId: null,
    },
    {
      id: 'txn_ac_09',
      companyId: 'acme',
      merchant: 'Metro Transit Authority',
      amountMinorUnits: 275,
      currency: 'USD',
      occurredAt: '2026-08-09T08:04:00.000Z',
      matchedReceiptId: null,
    },
  ];
}
