/**
 * Untrusted-file validation for receipt capture.
 *
 * THE POSTURE OF THIS FILE
 *
 * Everything the capture layer hands us about a file - its name, its MIME
 * type, its declared size - is a *claim made by attacker-controlled input*.
 * A file picker reports whatever the originating app wrote into the document
 * provider; a modified client reports whatever it likes. The only statement in
 * the set that is even weakly self-evidencing is the first few bytes of the
 * file itself, so the declared MIME type is treated as a hint and the magic
 * bytes are treated as the answer. When the two disagree the file is rejected
 * rather than silently reclassified: a disagreement is not a formatting quirk,
 * it is either a broken exporter or someone probing us.
 *
 * WHAT THIS FILE IS *NOT*
 *
 * It is not a security boundary. It runs on a device the attacker owns, so it
 * can be removed from the request path entirely. Its jobs are (a) give the
 * user a fast, honest error instead of a 30-second upload that dies at the
 * server, (b) keep junk out of the sync queue, and (c) tell the sync engine
 * whether retrying could ever help. The real boundary is server-side and is
 * documented in `PRODUCTION_QUARANTINE_BOUNDARY` at the bottom of this file.
 *
 * Pure module: no I/O, no clock, no randomness. Every answer is a function of
 * its arguments, which is what makes the hostile-input cases testable.
 */

// ---------------------------------------------------------------------------
// Limits and accepted types
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on a single receipt file.
 *
 * 10 MiB comfortably holds a 12-megapixel HEIC or a multi-page scanned PDF
 * while capping what one queued item can cost in device storage, mobile data
 * and server scan time. It is enforced again server-side against the actual
 * received byte count - the client's `sizeBytes` is a claim too.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Longest file name we will accept, in UTF-16 code units. */
const MAX_FILE_NAME_CHARS = 255;

/**
 * The only content types a receipt may be. Kept deliberately small: every
 * extra format is another parser on the server's attack surface.
 */
export const ACCEPTED_MIME_TYPES: ReadonlySet<string> = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'application/pdf',
]);

/**
 * Spellings seen in the wild that mean an accepted type.
 *
 * `image/jpg` is not a registered type but is what several Android document
 * providers emit; `image/heic-sequence` is what iOS reports for the HEIC burst
 * behind a Live Photo. Normalising them here means the agreement check below
 * compares like with like instead of failing honest files.
 */
const MIME_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
  ['image/heic-sequence', 'image/heic'],
  ['image/heif-sequence', 'image/heif'],
  ['application/x-pdf', 'application/pdf'],
  ['application/acrobat', 'application/pdf'],
]);

/**
 * Extension used when building a server-side storage key. Derived from *our*
 * validated type, never from the client's file name.
 */
const EXTENSION_BY_MIME: ReadonlyMap<string, string> = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  // Both HEIF labels deliberately map to ONE extension. isSameTypeFamily()
  // below already treats them as a single container, and safeStorageKey()
  // promises to be deterministic in localId. With separate extensions that
  // promise broke: a draft validated on the degraded path (no readable header,
  // so the DECLARED 'image/heif' is used) and the same draft validated with a
  // readable 'heic' brand produced two different object keys - one draft,
  // two orphaned objects in storage.
  ['image/heic', 'heic'],
  ['image/heif', 'heic'],
  ['image/webp', 'webp'],
  ['application/pdf', 'pdf'],
]);

/**
 * HEIC and HEIF are the same ISO-BMFF container with different brand codes,
 * and the two labels are used interchangeably by iOS, by Android and by every
 * HTTP client in between. Treating a heic/heif label difference as a
 * magic-byte mismatch would reject a large share of genuine iPhone receipts,
 * so the pair counts as one family for agreement purposes.
 */
const HEIF_FAMILY: ReadonlySet<string> = new Set<string>(['image/heic', 'image/heif']);

// ---------------------------------------------------------------------------
// Result contract
// ---------------------------------------------------------------------------

export type FileRejectionCode =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'MAGIC_MISMATCH'
  | 'UNSAFE_NAME';

export type FileValidationResult =
  | {
      readonly ok: true;
      /** The type we will tell the server this is. The sniffed value wins when we have one. */
      readonly normalizedMime: string;
      /** Null only when the caller could not read a header - see the degraded path below. */
      readonly sniffedMime: string | null;
    }
  | {
      readonly ok: false;
      readonly code: FileRejectionCode;
      /** Shown to a human: plain language, names the fix, no MIME types or byte counts. */
      readonly message: string;
      /**
       * Whether retrying *this same file* could ever succeed. The sync engine
       * reads this to choose between backoff-and-retry and permanent failure,
       * so a wrong `true` here is an infinite retry loop on a file that will
       * never pass.
       */
      readonly retryable: boolean;
    };

const MAX_MEGABYTES = Math.round(MAX_FILE_BYTES / (1024 * 1024));

const MESSAGES: Record<FileRejectionCode, string> = {
  EMPTY: 'That file is empty. Take the photo again, then attach it.',
  TOO_LARGE: `That file is too large. Receipts must be under ${MAX_MEGABYTES} MB - retake the photo at a lower resolution, or split a long PDF.`,
  UNSUPPORTED_TYPE:
    'That file type is not supported. Attach a photo (JPEG, PNG, HEIC or WebP) or a PDF.',
  MAGIC_MISMATCH:
    'That file does not look like the photo or PDF it claims to be, so we did not upload it. Retake the photo or choose a different file.',
  UNSAFE_NAME:
    'That file name is not allowed. Rename the file using letters, numbers, spaces and dashes, then attach it again.',
};

/** An unreadable size is a different user story from a genuinely zero-byte file. */
const UNREADABLE_SIZE_MESSAGE = 'We could not read that file. Take the photo again, then attach it.';

function reject(
  code: FileRejectionCode,
  retryable: boolean,
  message: string = MESSAGES[code],
): FileValidationResult {
  return { ok: false, code, message, retryable };
}

// ---------------------------------------------------------------------------
// Magic-byte sniffing
// ---------------------------------------------------------------------------

const SIG_JPEG: readonly number[] = [0xff, 0xd8, 0xff];
const SIG_PNG: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SIG_PDF: readonly number[] = [0x25, 0x50, 0x44, 0x46]; // '%PDF'

/**
 * ISO-BMFF major brands we accept. `mif1`/`msf1` are the generic HEIF still
 * and sequence brands; the `heic`/`heix`/`hev*` brands are HEVC-coded HEIF.
 * Anything else (notably `avif`, `mp42`, `isom`) sniffs as unknown - an
 * ISO-BMFF container is a *video* container as easily as an image one, and we
 * do not want the server's image pipeline opening an arbitrary MP4.
 */
const ISO_BMFF_BRANDS: ReadonlyMap<string, string> = new Map<string, string>([
  ['heic', 'image/heic'],
  ['heix', 'image/heic'],
  ['heim', 'image/heic'],
  ['heis', 'image/heic'],
  ['hevc', 'image/heic'],
  ['hevx', 'image/heic'],
  ['hevm', 'image/heic'],
  ['hevs', 'image/heic'],
  ['mif1', 'image/heif'],
  ['msf1', 'image/heif'],
]);

/** Leading bytes a caller must supply for every signature to be decidable. */
export const MIN_SNIFF_BYTES = 12;

function matchesAt(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string | null {
  if (bytes.length < offset + length) return null;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[offset + i];
    if (byte === undefined) return null; // unreachable after the bounds check; keeps us off `!`
    out += String.fromCharCode(byte);
  }
  return out;
}

/**
 * Identify a file from its leading bytes, or null if it is not one of the
 * formats we accept.
 *
 * Callers should pass at least {@link MIN_SNIFF_BYTES} bytes; fewer may sniff
 * as null even for a genuine file, and null is treated as hostile.
 *
 * Deliberately strict in two ways:
 *  - Signatures must sit at their exact offset. The PDF spec tolerates up to
 *    1 KB of leading junk before `%PDF` and readers honour that, which is
 *    precisely the polyglot shape (a file that is a valid GIF *and* a valid
 *    PDF, or a valid JPEG *and* a valid HTML page) we refuse to forward.
 *  - Only the ISO-BMFF *major* brand is read. Compatible brands listed later
 *    in the `ftyp` box are ignored; parsing them properly needs a real box
 *    walker, and that parser belongs on the scan server, not in the client.
 */
export function sniffMimeFromMagicBytes(bytes: Uint8Array): string | null {
  if (matchesAt(bytes, 0, SIG_PNG)) return 'image/png';
  if (matchesAt(bytes, 0, SIG_JPEG)) return 'image/jpeg';
  if (matchesAt(bytes, 0, SIG_PDF)) return 'application/pdf';

  // RIFF is a generic container (WAV, AVI); the 'WEBP' form type at byte 8 is
  // what makes it an image.
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return 'image/webp';

  if (asciiAt(bytes, 4, 4) === 'ftyp') {
    const brand = asciiAt(bytes, 8, 4);
    if (brand !== null) {
      const mime = ISO_BMFF_BRANDS.get(brand.toLowerCase());
      if (mime !== undefined) return mime;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// File-name safety
// ---------------------------------------------------------------------------

const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set<string>([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 10 }, (_unused, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_unused, i) => `lpt${i}`),
]);

/** NUL and every other C0/C1 control character. */
// C0 controls, DEL, and the C1 block. Written as escapes on purpose: the
// literal characters would make this source file binary to git and grep.
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/;

/**
 * Bidirectional and invisible formatting marks. U+202E flips rendering, so
 * `receipt<U+202E>gpj.exe` displays as `receipt exe.jpg` - name spoofing, not
 * a legitimate receipt name.
 */
const BIDI_CONTROL_CHARS = /[​-‏‪-‮⁦-⁩﻿]/;

/** Percent-encoded separators and dots, in case some layer downstream decodes. */
const ENCODED_PATH_CHARS = /%(?:2e|2f|5c|00)/i;

/** A leading `C:` / `c:` drive designator. */
const DRIVE_LETTER = /^[a-z]:/i;

/**
 * Is this name unsafe to accept, log, or echo back?
 *
 * We never write the client's name to disk - `safeStorageKey()` generates the
 * server-side key - so this check exists to (1) refuse obviously hostile input
 * at the earliest possible point, (2) keep traversal sequences and control
 * characters out of logs, audit records and support tooling, and (3) treat a
 * client that sends such a name as compromised and stop processing it.
 */
export function isUnsafeFileName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_FILE_NAME_CHARS) return true;

  // Windows silently strips trailing dots and spaces, so `evil.php ` and
  // `evil.php` name the same file; whitespace padding is also how a display
  // name hides its real extension.
  if (name !== name.trim()) return true;
  if (name.endsWith('.')) return true;

  if (CONTROL_CHARS.test(name)) return true;
  if (BIDI_CONTROL_CHARS.test(name)) return true;
  if (ENCODED_PATH_CHARS.test(name)) return true;

  // A file *name* has no separators at all. Banning both outright makes
  // `../`, `..\`, `/etc/passwd` and `\\host\share` impossible in one rule.
  if (name.includes('/') || name.includes('\\')) return true;
  if (DRIVE_LETTER.test(name)) return true;

  if (name === '.' || name === '..') return true;

  // `con.jpg` is still the console device on Windows: the reserved word is the
  // stem, not the whole string.
  const stem = name.split('.')[0];
  if (stem !== undefined && RESERVED_DEVICE_NAMES.has(stem.toLowerCase())) return true;

  return false;
}

// ---------------------------------------------------------------------------
// MIME normalisation
// ---------------------------------------------------------------------------

/** Lowercase, trimmed, parameters (`; charset=binary`) stripped, aliases resolved. */
function normalizeMime(raw: string): string {
  const bare = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_ALIASES.get(bare) ?? bare;
}

/** heic/heif are interchangeable labels for one container; nothing else is. */
function isSameTypeFamily(a: string, b: string): boolean {
  if (a === b) return true;
  return HEIF_FAMILY.has(a) && HEIF_FAMILY.has(b);
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

export interface ReceiptFileInput {
  readonly fileName: string;
  /** What the picker/OS said the type is. A claim. Null when nothing was reported. */
  readonly declaredMime: string | null;
  readonly sizeBytes: number;
  /**
   * The file's leading bytes (at least {@link MIN_SNIFF_BYTES}). Null ONLY when
   * the platform genuinely could not give us a header - see the degraded path.
   */
  readonly magicBytes: Uint8Array | null;
}

/**
 * Validate a candidate receipt file.
 *
 * ORDER IS PART OF THE CONTRACT, cheapest and most-hostile first:
 *
 *   1. NAME SAFETY   - a traversal or control-character name means the client
 *                      is hostile or broken. Stop before touching anything
 *                      else, and before the name can reach a log line.
 *   2. EMPTINESS     - distinguishes "nothing was captured / the copy had not
 *                      flushed yet" from "a real file that breaks a rule". It
 *                      is the one rejection that is retryable.
 *   3. SIZE          - pure arithmetic, and rejecting here avoids reading or
 *                      hashing 200 MB we were never going to accept.
 *   4. DECLARED TYPE - if the client *admits* to a type we do not take, we can
 *                      say so without inspecting bytes at all.
 *   5. MAGIC BYTES   - the only evidence in the set. MAGIC BYTES WIN: a
 *                      disagreement with the declared type is a rejection, not
 *                      a reclassification, and the sniffed value is what we
 *                      report on success.
 */
export function validateReceiptFile(input: ReceiptFileInput): FileValidationResult {
  const { fileName, declaredMime, sizeBytes, magicBytes } = input;

  // 1. Name safety. Permanent: the same file under the same name never passes.
  if (isUnsafeFileName(fileName)) return reject('UNSAFE_NAME', false);

  // 2. Emptiness - and the nonsense-number trap. `NaN < 0` and
  //    `NaN > MAX_FILE_BYTES` are both false, so a NaN size would sail through
  //    every comparison below if it were not caught explicitly here.
  if (!Number.isFinite(sizeBytes) || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
    return reject('EMPTY', true, UNREADABLE_SIZE_MESSAGE);
  }
  if (sizeBytes === 0) {
    // Retryable, unlike every other rejection: the usual cause is reading the
    // sandbox copy before the write flushed, and the same URI can yield real
    // bytes moments later.
    return reject('EMPTY', true);
  }

  // 3. Size. Inclusive boundary: exactly MAX_FILE_BYTES is acceptable.
  //    Not retryable - the file will not get smaller on its own, so the sync
  //    engine must fail it permanently rather than burn battery on backoff.
  //    (Brief edge case 4: an oversized HEIC lands here.)
  if (sizeBytes > MAX_FILE_BYTES) return reject('TOO_LARGE', false);

  // 4. Declared type.
  const declared = declaredMime === null ? null : normalizeMime(declaredMime);
  if (declared !== null && !ACCEPTED_MIME_TYPES.has(declared)) {
    return reject('UNSUPPORTED_TYPE', false);
  }

  // 5. Magic-byte agreement.
  if (magicBytes === null) {
    // DEGRADED PATH: the platform gave us no header (some content providers
    // return a URI that cannot be read until upload time). We can verify
    // nothing, so we fall back to the declared type and report `sniffedMime`
    // as null, so the caller can see this file was never verified on-device.
    // Safe only because the server re-sniffs in quarantine and is the
    // authority - not a hole we are choosing to leave open.
    if (declared === null) return reject('UNSUPPORTED_TYPE', false);
    return { ok: true, normalizedMime: declared, sniffedMime: null };
  }

  const sniffed = sniffMimeFromMagicBytes(magicBytes);

  if (sniffed === null) {
    // Bytes were supplied and they are not any format we accept: the
    // renamed-executable / polyglot case. A zero-length byte array lands here
    // too - a caller that read nothing out of a non-empty file has told us
    // something is wrong, and fail-closed is the only safe direction.
    return reject('MAGIC_MISMATCH', false);
  }

  if (declared !== null && !isSameTypeFamily(sniffed, declared)) {
    return reject('MAGIC_MISMATCH', false);
  }

  // Magic bytes win: the sniffed type is what we upload under, even when the
  // declared type agreed. The client never gets to name the content type.
  return { ok: true, normalizedMime: sniffed, sniffedMime: sniffed };
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/**
 * Identifier shape allowed inside a storage key. No dot, so `.` and `..` are
 * structurally impossible; no slash, so a company can never escape its own
 * prefix. Ids are our own (uuid-ish) values, so this is defence in depth
 * rather than input sanitising - and we REJECT rather than rewrite, because
 * rewriting `acme/../globex` into `acme___globex` could silently collide two
 * tenants into one prefix.
 */
const STORAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertKeySegment(value: string, label: string): void {
  if (!STORAGE_ID_PATTERN.test(value)) {
    throw new Error(
      `Refusing to build a storage key: ${label} '${value}' is not a safe key segment`,
    );
  }
}

/**
 * The server-side object key for a receipt file.
 *
 * Three properties matter:
 *
 *  - IT NEVER EMBEDS THE CLIENT FILE NAME. A name is untrusted display text;
 *    putting it in a path is how traversal, over-length keys and
 *    `Content-Disposition` surprises happen. The original name, if worth
 *    keeping at all, belongs in a metadata column where it is data, not a path.
 *  - IT IS COMPANY-SCOPED. The prefix lets storage-level policy deny
 *    cross-tenant reads outright. The prefix is *organisation*, though, not
 *    *authorisation*: the read path must still check the caller's active
 *    company at request time.
 *  - IT IS DETERMINISTIC IN `localId`. A retried upload of the same draft
 *    writes the same object instead of littering storage with orphans - the
 *    storage-layer half of the idempotency story `idempotencyKey` tells at the
 *    API layer (brief edge case 1: the success response is lost and the client
 *    retries).
 *
 * @throws if either id is not a safe key segment, or `mime` is not one of the
 * validated accepted types - we do not mint keys for content we never checked.
 */
export function safeStorageKey(companyId: string, localId: string, mime: string): string {
  assertKeySegment(companyId, 'companyId');
  assertKeySegment(localId, 'localId');

  const extension = EXTENSION_BY_MIME.get(normalizeMime(mime));
  if (extension === undefined) {
    throw new Error(`Refusing to build a storage key for unvalidated content type '${mime}'`);
  }

  return `companies/${companyId}/receipts/${localId}.${extension}`;
}

// ---------------------------------------------------------------------------
// The production boundary this file does not replace
// ---------------------------------------------------------------------------

/**
 * PRODUCTION VALIDATION AND QUARANTINE BOUNDARY.
 *
 * Everything above runs on hardware the attacker controls and can therefore be
 * removed from the request path entirely. It buys the user a fast error and
 * the queue some hygiene. It buys the *server* nothing. The text below is the
 * boundary that actually holds, written out because "we validate on the
 * client" is the most common way this class of feature ships broken.
 */
export const PRODUCTION_QUARANTINE_BOUNDARY = `
PRODUCTION VALIDATION / QUARANTINE BOUNDARY
===========================================
The client-side checks in validation.ts are a UX filter and a queue-hygiene
filter. They are NOT a security control: they execute on a device the attacker
owns, and a patched client simply omits them. Assume every byte, every declared
MIME type, every declared length and every file name arriving at the server was
chosen by an adversary.

1. INGEST IS WRITE-ONLY AND ISOLATED.
   The client never writes to durable storage. It PUTs to a quarantine bucket
   through a short-lived pre-signed URL that pins the object key
   (server-generated, see safeStorageKey), a maximum Content-Length and the
   expected Content-Type. The quarantine bucket has public access blocked, no
   CDN attached, no static-website serving, object versioning on, default
   encryption on, and a lifecycle rule that expires unpromoted objects within
   hours so failed uploads cannot accumulate.

2. EVERY CLIENT CHECK IS RE-RUN SERVER-SIDE ON THE RECEIVED BYTES.
   Size from the actual stream length, not from a header. Type from the
   server's own magic-byte sniff, not from Content-Type. The name is not used
   for anything. The client's answers are kept only to fail fast and to detect
   clients that are lying: a mismatch between the client's claim and the
   server's truth is a security signal worth logging and rate-limiting on.

3. OUT-OF-BAND SCAN BEFORE ANY PROMOTION.
   An asynchronous scanner runs in a sandbox with no network egress, no
   credentials, a read-only mount and hard CPU/memory/wall-clock budgets:
     - anti-virus and known-malware signatures;
     - polyglot and appended-payload detection: a file that is simultaneously a
       valid JPEG and a valid ZIP/HTML/JS, or that carries trailing data after
       the image's own end-of-stream marker, is rejected, not trimmed;
     - decompression and decode bombs: pixel-dimension and total-pixel caps,
       PDF object/stream/recursion limits, XML entity-expansion limits;
     - active content in PDFs: /JavaScript, /OpenAction, /Launch, /EmbeddedFile,
       remote /URI actions and XFA forms are all disqualifying for a receipt;
     - HEIC/HEIF specifically: the mobile image parsers behind this format have
       a long CVE history, so decoding happens only inside the sandbox and
       never in the API process.

4. TRANSCODE RATHER THAN TRUST.
   A file that passes is decoded with a hardened library and re-encoded into a
   canonical form: JPEG for images, linearised PDF with active content removed
   for documents. Re-encoding destroys smuggled payloads that no signature scan
   would have recognised, and it normalises the wild variety of
   camera-produced containers into something OCR and the viewer can rely on.

5. STRIP EXIF / GPS / DEVICE METADATA DURING TRANSCODE.
   A receipt photo routinely carries the precise coordinates of an employee's
   home or a client site, plus the device serial and the capture timestamp.
   None of it is needed to reimburse an expense, all of it is personal data we
   would then owe duties over, and it would otherwise leak to every downstream
   OCR vendor. Orientation is read, applied to the pixels, then discarded with
   the rest. Stripping happens server-side, because a client-side strip is just
   another client claim.

6. PROMOTE ONLY ON PASS.
   The transcoded object is written to durable storage under the server's own
   key, the receipt row is updated to reference the durable key, and the
   quarantine object is deleted. The receipt is not viewable, not downloadable
   and not fed to OCR before this step. A failed scan marks the receipt
   permanently failed (retryable=false, so the sync engine stops retrying),
   quarantines the object for forensics and alerts - it never becomes a
   user-facing retry loop. A scanner outage yields "pending scan", never an
   optimistic promotion.

7. NOTHING IS EVER SERVED FROM QUARANTINE.
   No read URL - pre-signed or otherwise - is issued for a quarantine object,
   for any reason, including support tooling. Durable objects are served from a
   separate cookie-less origin/CDN, with Content-Type set from the server's own
   sniff, X-Content-Type-Options: nosniff, Content-Disposition: attachment for
   anything not rendered inline, and a restrictive CSP with PDF viewing
   sandboxed. Serving user files from the app's own origin turns any stored
   HTML polyglot into stored XSS against a live session.

8. TENANCY IS CHECKED AT READ TIME, NOT INFERRED FROM THE KEY.
   The company-scoped prefix organises storage and enables coarse bucket
   policy; it is not authorisation. Every read re-checks the caller's ACTIVE
   company against the receipt row, so a company switch or a stale link cannot
   surface another tenant's receipt.

9. AUDIT AND RE-SCAN.
   Record the uploader, the active company, the client-declared type, the
   server-sniffed type, the byte length and the SHA-256 of the received bytes.
   The hash supports dedupe, answers "was this exact file ever accepted", and
   lets a later signature-database update re-scan objects already promoted.
`.trim();
