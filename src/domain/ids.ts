/**
 * Identity and idempotency.
 *
 * This module answers one question: "is this the SAME submission I already
 * sent, or a different one?" Everything the brief says about retries hinges on
 * it.
 *
 *   - Retrying the same submission must reuse the same idempotency key, so a
 *     server that already created the record returns the original instead of a
 *     duplicate. That is the whole fix for "the upload succeeded but the
 *     success response was lost".
 *
 *   - Submitting something MEANINGFULLY DIFFERENT must use a new key, or the
 *     server's dedupe would match it against the old record and silently throw
 *     away the user's correction.
 *
 * The module is pure: no clock, no global randomness, no storage. Randomness is
 * injected so that ids are deterministic under test.
 */

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

/**
 * A source of randomness returning a float in [0, 1), like `Math.random`.
 *
 * Injected rather than imported so tests can seed it. In production this should
 * be backed by a CSPRNG (e.g. expo-crypto's random bytes normalised to [0,1)),
 * not `Math.random`: an idempotency key that a second device can guess or
 * collide with would let one submission dedupe against another's record.
 */
export type RandomSource = () => number;

/**
 * URL- and filename-safe alphabet (RFC 4648 §5 "base64url" characters).
 * Exactly 64 symbols, so each drawn character carries 6 bits and the ids can
 * travel in a path segment, a query string or a header without escaping.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const LOCAL_ID_PREFIX = 'rcp_';
const LOCAL_ID_BODY_LENGTH = 22; // 22 * 6 = 132 bits
const IDEMPOTENCY_KEY_PREFIX = 'idem_';
const IDEMPOTENCY_KEY_BODY_LENGTH = 32; // 32 * 6 = 192 bits

/** Anchored, non-multiline: a trailing newline or any padding must NOT pass. */
const IDEMPOTENCY_KEY_PATTERN = /^idem_[A-Za-z0-9_-]{32}$/;

/**
 * A `RandomSource` is an injected dependency, which makes it untrusted input
 * like any other. A source that returns exactly 1, a negative number or NaN
 * must not be able to shorten an id: `String.charAt` out of range returns '',
 * which would silently produce a 21-character — and therefore more
 * collision-prone — id. Clamping keeps the id well-formed; a biased source can
 * only weaken entropy, never the format.
 */
function indexFrom(r: number, size: number): number {
  if (!Number.isFinite(r)) return 0;
  const i = Math.floor(r * size);
  if (i < 0) return 0;
  if (i >= size) return size - 1;
  return i;
}

function randomBody(rand: RandomSource, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET.charAt(indexFrom(rand(), ALPHABET.length));
  }
  return out;
}

/**
 * Device-local primary key for a `ReceiptDraft`. Prefixed so that a local id
 * can never be mistaken for a `serverReceiptId` in a log, a URL or a bug
 * report — the two live side by side on every draft and mean very different
 * things.
 */
export function newLocalId(rand: RandomSource): string {
  return LOCAL_ID_PREFIX + randomBody(rand, LOCAL_ID_BODY_LENGTH);
}

/**
 * A fresh idempotency key. Minted when a draft is created and again ONLY when
 * the submission's substance changes — see `shouldRotateIdempotencyKey`.
 */
export function newIdempotencyKey(rand: RandomSource): string {
  return IDEMPOTENCY_KEY_PREFIX + randomBody(rand, IDEMPOTENCY_KEY_BODY_LENGTH);
}

/**
 * Validates a key read back from persistence or from a server response.
 *
 * Persisted state is untrusted input: a truncated write or a hand-edited
 * database would otherwise send a malformed key to the server, where it would
 * dedupe against nothing and quietly create duplicates.
 */
export function isIdempotencyKey(s: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(s);
}

// ---------------------------------------------------------------------------
// Key lifetime
// ---------------------------------------------------------------------------

/**
 * How long a key stays meaningful, on both sides.
 *
 * CLIENT: the key is minted with the draft, persisted on it, and reused
 * unchanged across every retry — including retries after the app was killed and
 * relaunched. It rotates only on a substantive edit.
 *
 * SERVER contract for a submission carrying key K:
 *
 *   - K NEVER SEEN -> do the work, record (K -> receipt id) for at least this
 *     TTL, return the new receipt id. A key the server has never seen is always
 *     a first attempt; it must never be rejected merely for being unfamiliar.
 *
 *   - K SEEN, WITHIN TTL -> do NOT create a second record. Return the ORIGINAL
 *     receipt id (and its current state). This is what makes a retry after a
 *     lost success response safe: the response was lost, the record was not.
 *
 *   - K SEEN, TTL EXPIRED (entry evicted) -> the server can no longer prove
 *     whether K was processed, so it must not guess. Treat a stale key as a
 *     conflict rather than silently creating a duplicate, and make the client
 *     reconcile — list the company's receipts and either adopt the existing
 *     record or ask the user. A client holding an unconfirmed draft whose key
 *     is older than the TTL should reconcile BEFORE retrying, for the same
 *     reason.
 *
 * 24 hours is chosen to outlast a realistic offline window (a driver capturing
 * receipts overnight with no signal) while keeping the server's dedupe table
 * small enough to be cheap.
 */
export const IDEMPOTENCY_KEY_TTL_HOURS = 24;

// ---------------------------------------------------------------------------
// Submission intent
// ---------------------------------------------------------------------------

/**
 * The SUBSTANCE of a submission — what the user is asking the server to record.
 *
 * Deliberately excludes:
 *   - `notes`: free text the user may reword forever; re-typing a note is not a
 *     new receipt.
 *   - `companyId`: a company change must BLOCK the upload, not re-key it. See
 *     the comment on `shouldRotateIdempotencyKey`.
 *   - attempt counts, timestamps, error text: they describe the sending, not
 *     the thing being sent.
 */
export interface SubmissionIntent {
  readonly fileUri: string | null;
  readonly vendor: string | null;
  readonly amountMinorUnits: number | null;
  readonly currency: string | null;
  readonly transactionDate: string | null;
  readonly matchTransactionId: string | null;
}

/**
 * Bumped if the canonicalisation below ever changes. Fingerprints are compared
 * against ones computed by an older build (a draft persisted before an app
 * update), so a silent change of encoding would make an unchanged intent look
 * edited — and rotate a key that should have been reused.
 */
const FINGERPRINT_VERSION = 'v1';

/**
 * Tags make the encoding injective: the first character says whether a value is
 * absent or present, so no real value can ever impersonate an absent one.
 */
const ABSENT = '-';
const PRESENT = ':';

/**
 * Normalisation is deliberately CONSERVATIVE. Every rule that merges two
 * different user inputs into one fingerprint is a rule that can silently
 * discard a correction (the server would dedupe the "new" submission against
 * the old record). So only changes that cannot carry user intent are removed.
 */

/** Surrounding whitespace is keyboard noise, never a correction. Blank == absent. */
function normalizeString(v: string | null): string | null {
  if (v === null) return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * ISO 4217 codes are case-insensitive identifiers, so 'usd' and 'USD' name the
 * same currency and must not look like two different submissions. This is the
 * only normalisation here that changes characters rather than removing them.
 */
function normalizeCurrency(v: string | null): string | null {
  const s = normalizeString(v);
  return s === null ? null : s.toUpperCase();
}

function encodeString(v: string | null): string {
  // encodeURIComponent escapes '&' and '=', the two separators used below, so a
  // vendor literally named "x&vendor=y" cannot forge another field.
  return v === null ? ABSENT : PRESENT + encodeURIComponent(v);
}

function encodeAmount(v: number | null): string {
  if (v === null) return ABSENT;
  // `v === 0` is true for -0, so this maps -0 to 0: a signed zero is the same
  // amount, but String(-0) is '-0' and would otherwise fingerprint differently.
  // Non-integer or non-finite values can only come from a bug upstream; they are
  // encoded verbatim rather than rounded, so they stay distinguishable instead of
  // colliding with a legitimate neighbouring amount.
  const canonical = v === 0 ? 0 : v;
  return PRESENT + encodeURIComponent(String(canonical));
}

/**
 * A stable, order-independent, canonical string for a submission's substance.
 *
 * Order-independent in two senses: the fingerprint does not depend on the key
 * order of the object literal it was built from (JS object key order is an
 * implementation detail that survives neither JSON round-trips nor a schema
 * change), and the field list is sorted at runtime rather than trusted to be
 * written in order.
 */
export function intentFingerprint(intent: SubmissionIntent): string {
  const fields: (readonly [keyof SubmissionIntent, string])[] = [
    ['fileUri', encodeString(normalizeString(intent.fileUri))],
    ['vendor', encodeString(normalizeString(intent.vendor))],
    ['amountMinorUnits', encodeAmount(intent.amountMinorUnits)],
    ['currency', encodeString(normalizeCurrency(intent.currency))],
    // A DateOnly is compared as an opaque calendar string. It is never parsed
    // into an instant: doing so would require inventing a timezone, and a
    // 2026-01-01 receipt must not become 2025-12-31 just because we fingerprinted it.
    ['transactionDate', encodeString(normalizeString(intent.transactionDate))],
    ['matchTransactionId', encodeString(normalizeString(intent.matchTransactionId))],
  ];

  fields.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return `${FINGERPRINT_VERSION}|${fields.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

/**
 * THE key decision: does this submission need a NEW idempotency key?
 *
 * The idempotency key is a promise to the server: "if you have seen this key,
 * you have already done this exact work — give me back what you made, do not
 * make another." Both halves of that promise can be broken, and the two
 * failures are not symmetrical:
 *
 *   ROTATING WHEN WE SHOULD NOT HAVE creates DUPLICATES. The first attempt
 *   really did reach the server, the response was lost, and the retry arrives
 *   with a key the server has never seen — so it dutifully creates a second
 *   receipt, and possibly a second match against the same card transaction.
 *   The user sees double and an approver has to clean it up.
 *
 *   NOT ROTATING WHEN WE SHOULD HAVE causes SILENT DATA LOSS. The user fixes a
 *   wrong amount, or attaches a clearer photo, and resubmits. The server
 *   recognises the key, decides the work is already done, and returns the OLD
 *   record. The app then shows "confirmed" over data the user explicitly
 *   corrected, and nothing anywhere reports an error.
 *
 * Silent loss of a correction is worse than a visible duplicate, so the rule is
 * drawn tightly: any change to WHAT is being submitted rotates. A pure retry —
 * same file, same money, same date, same match target — never does.
 *
 * Note what is NOT here:
 *
 *   `notes` is excluded. Notes are free text the user may reword any number of
 *   times while a draft sits in the queue; treating each rewording as a new
 *   submission would defeat dedupe exactly when it matters most (a long offline
 *   queue), and a note carries no matching or accounting meaning.
 *
 *   `companyId` is excluded, and its absence is load-bearing. If the user
 *   switches company or logs out while a draft is queued, the right answer is
 *   that the draft is NOT uploadable at all — the sync engine refuses any draft
 *   whose stamped companyId differs from the active session. Rotating the key
 *   would express the opposite: "this is a new submission, send it", under the
 *   wrong company. So the company boundary is enforced by refusing to send, not
 *   by re-keying.
 *
 * LIFETIME: a key born here lives on the draft until the next substantive edit,
 * across app kills and relaunches, bounded by IDEMPOTENCY_KEY_TTL_HOURS on the
 * server side. Rotation is the caller's job — this function only decides.
 */
export function shouldRotateIdempotencyKey(prev: SubmissionIntent, next: SubmissionIntent): boolean {
  return intentFingerprint(prev) !== intentFingerprint(next);
}
