/**
 * Push notification POLICY — the pure decision layer.
 *
 * This module decides two things and nothing else:
 *
 *   1. Is there a transition here the user would actually care about, and did
 *      not cause themselves?
 *   2. If so, what exactly do we say, and under which collapse key?
 *
 * It does NOT schedule, present, request permission, or touch
 * expo-notifications. A thin native wrapper does that, and it is also the layer
 * that knows things this one cannot — whether the app is foregrounded, whether
 * the user granted permission, whether the OS rate-limited us. Keeping the
 * decision here, with no I/O, no clock and no randomness, is what makes the
 * privacy rule and the "never claim confirmation" rule testable rather than
 * aspirational.
 *
 * THREE RULES ARE ENCODED BELOW, EACH FOR A REASON
 *
 * NEVER NOTIFY FOR THE USER'S OWN ACTION. draft -> queued -> uploading are
 * local states this device assigned to itself, moments after the user tapped
 * Submit. Buzzing someone's phone to report what they just did is noise, and
 * worse, it trains them to ignore the notification that matters.
 *
 * NEVER CLAIM CONFIRMATION WITHOUT EVIDENCE. Same invariant as the rest of the
 * app: `state === 'confirmed'` is a local belief; `serverReceiptId` is the only
 * proof a business record exists. A notification is the loudest, least
 * retractable surface we have — a lock screen saying "confirmed" about a
 * receipt the server never created is exactly the failure the brief forbids, so
 * a server-state claim with no server id produces nothing at all.
 *
 * NEVER PUT THE AMOUNT IN THE BODY. See `bodyFor()`.
 */

import { isServerConfirmed, type ReceiptDraft } from '../domain/types';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Why we are notifying.
 *
 * 'none' is the absence of a reason. `planNotification` signals that by
 * returning null rather than a plan carrying 'none' — a null plan cannot be
 * accidentally handed to a presenter, whereas a plan with a 'none' trigger
 * can. The variant still exists because the classifier needs a total return
 * type, and because the native wrapper can switch exhaustively over it.
 */
export type NotifyTrigger = 'confirmed' | 'needsReview' | 'permanentlyFailed' | 'none';

export interface NotificationPlan {
  readonly trigger: NotifyTrigger;
  readonly title: string;
  readonly body: string;
  /** Deep link into the app, e.g. '/receipt/rcp_xxx'. */
  readonly route: string;
  /** Collapse key, so repeated updates about one receipt replace rather than stack. */
  readonly threadKey: string;
  readonly companyId: string;
}

/** The triggers that can actually produce a plan. */
type FiringTrigger = Exclude<NotifyTrigger, 'none'>;

// ---------------------------------------------------------------------------
// Copy limits
// ---------------------------------------------------------------------------

/**
 * A lock screen truncates hard anyway; truncating here means WE choose where
 * the cut lands instead of the OS choosing mid-sentence.
 */
const MAX_VENDOR_CHARS = 40;
const MAX_COMPANY_CHARS = 60;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * The notifiable condition a draft is currently in, or 'none'.
 *
 * Deliberately a function of ONE draft: the three conditions are mutually
 * exclusive states, so there is no priority ordering to get wrong, and
 * "did this change?" reduces to comparing two condition values.
 */
function conditionOf(d: ReceiptDraft): NotifyTrigger {
  // isServerConfirmed(), not state === 'confirmed'. The id is the evidence.
  if (isServerConfirmed(d)) return 'confirmed';

  // needsReview is equally a claim about what a server did ("we received your
  // file but could not read it"), so it demands the same evidence. Without an
  // id we have no grounds to say the server has anything.
  if (d.state === 'needsReview' && d.serverReceiptId !== null) return 'needsReview';

  // 'failed' is a local state, but the user did not cause it and retrying will
  // not clear it — this receipt is stuck until a human intervenes. That is
  // worth an interruption; a retryable blip is not, because the sync engine
  // will quietly handle it.
  if (d.state === 'failed' && !d.lastErrorRetryable) return 'permanentlyFailed';

  return 'none';
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** C0 controls and DEL, which must never reach a system notification verbatim. */
// Written as escapes on purpose: the literal characters would make this
// source file binary to git and grep.
const CONTROL_CHARS = /[\x00-\x1F\x7F]+/g;

/**
 * Collapse whitespace and drop control characters, then truncate on code-point
 * boundaries.
 *
 * The vendor can originate from OCR of a user-supplied file, which makes it
 * untrusted input like the file itself: newlines, tabs and C0 controls would
 * otherwise be interpolated straight into a notification body. Slicing by code
 * point (not by UTF-16 unit) keeps truncation from splitting a surrogate pair
 * into a lone half that renders as a replacement glyph.
 */
function tidy(text: string, maxChars: number): string {
  const collapsed = text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(collapsed);
  if (chars.length <= maxChars) return collapsed;
  return `${chars.slice(0, maxChars - 1).join('').trimEnd()}…`;
}

/** 'Your Blue Bottle receipt', or just 'Your receipt' when we have no vendor. */
function vendorPhrase(vendor: string | null): string {
  const name = vendor === null ? '' : tidy(vendor, MAX_VENDOR_CHARS);
  return name === '' ? 'Your receipt' : `Your ${name} receipt`;
}

/**
 * The company is not decoration. The user belongs to two, so "Your receipt was
 * confirmed" is ambiguous on its face — it does not say which set of books it
 * landed in. If the caller hands us no usable name, we fall back to the id:
 * ugly on a lock screen, but unambiguous, which is the entire job of this
 * string.
 */
function companyLabel(companyName: string, companyId: string): string {
  const named = tidy(companyName, MAX_COMPANY_CHARS);
  return named === '' ? tidy(companyId, MAX_COMPANY_CHARS) : named;
}

const TITLES: Readonly<Record<FiringTrigger, string>> = {
  confirmed: 'Receipt confirmed',
  needsReview: 'Receipt needs review',
  permanentlyFailed: 'Receipt could not be sent',
};

/**
 * PRIVACY: the body names the vendor and the company, and NEVER the amount.
 *
 * This is a deliberate trade-off, not an oversight. A notification renders on a
 * locked screen, in an office, on a train, over someone's shoulder — and it is
 * mirrored to watches, car displays and desktop notification centres, none of
 * which the user is thinking about when they submit a lunch receipt. The amount
 * is the single most sensitive field on an expense record and the one a
 * bystander can read and interpret instantly.
 *
 * What we lose is glanceability: the user cannot verify the figure without
 * opening the app. We accept that, because the amount is one tap away behind
 * the device lock and the deep link goes straight to it. Vendor and company are
 * kept because without them the notification is not actionable at all — the
 * user has two companies and many receipts, and "a receipt was confirmed" tells
 * them nothing they can act on.
 *
 * Consequence for maintainers: nothing in this function may read
 * `amountMinorUnits` or `currency`, and nothing here may call money.ts's
 * formatters. A test asserts the amount's digits never reach a rendered body.
 */
function bodyFor(trigger: FiringTrigger, vendor: string, company: string): string {
  switch (trigger) {
    case 'confirmed':
      return `${vendor} was confirmed for ${company}.`;
    case 'needsReview':
      return `${vendor} needs a quick review before it can be filed for ${company}.`;
    case 'permanentlyFailed':
      return `${vendor} could not be sent for ${company}. Open it to fix and resubmit.`;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Decide what, if anything, to tell the user about a receipt that just changed.
 *
 * `previous` and `next` must be the same receipt before and after one update.
 * Returns null whenever there is nothing worth saying: no real transition, a
 * purely local move the user made themselves, or a server claim we cannot
 * evidence.
 *
 * Pure and total: same inputs, same output, byte for byte. No clock, no
 * randomness, no I/O — the wrapper supplies delivery-time concerns.
 */
export function planNotification(
  previous: ReceiptDraft,
  next: ReceiptDraft,
  companyName: string,
): NotificationPlan | null {
  // Two different receipts are not a transition. A caller that pairs them up
  // wrongly gets silence rather than a plausible-looking notification about the
  // wrong record. companyId is stamped at capture and never rewritten, so a
  // mismatch means the same thing.
  if (previous.localId !== next.localId) return null;
  if (previous.companyId !== next.companyId) return null;

  // A plan without these has no company to scope to and no route to open.
  if (next.localId === '' || next.companyId === '') return null;

  const trigger = conditionOf(next);
  if (trigger === 'none') return null;

  // The condition must have BECOME true. Re-announcing a state the receipt was
  // already in is how a background sync that re-reads the same row turns into a
  // buzz every poll — and it also covers "previous and next differ in nothing
  // relevant", e.g. a permanently failed receipt whose error text was reworded.
  if (conditionOf(previous) === trigger) return null;

  const company = companyLabel(companyName, next.companyId);

  return {
    trigger,
    title: TITLES[trigger],
    body: bodyFor(trigger, vendorPhrase(next.vendor), company),
    // Ids are already URL-safe by construction (see ids.ts), so this is a no-op
    // for well-formed data — it is here so a malformed id from an old row
    // cannot reshape the deep link it is interpolated into.
    route: `/receipt/${encodeURIComponent(next.localId)}`,
    // Company first, and both segments encoded so a delimiter inside an id
    // cannot make two different receipts share one key. The trigger is
    // deliberately NOT part of the key: needsReview followed by confirmed is
    // one story about one receipt and should replace itself, not stack.
    threadKey: `receipt:${encodeURIComponent(next.companyId)}:${encodeURIComponent(next.localId)}`,
    companyId: next.companyId,
  };
}
