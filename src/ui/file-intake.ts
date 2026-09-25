/**
 * Bringing a picked file under our control.
 *
 * Two things happen here and the order matters:
 *
 * 1. COPY IT INTO THE APP SANDBOX FIRST.
 *    A picker URI can point at a shared/temporary container the OS is free to
 *    reclaim — the classic symptom is a receipt that uploads fine immediately
 *    but fails days later when the queue finally drains. Durability is the
 *    whole point of the offline story, so we own the bytes before we promise
 *    anything.
 *
 * 2. THEN VALIDATE WHAT WE ACTUALLY HAVE, not what we were told.
 *    Size and magic bytes are read back off our own copy.
 */

import { validateReceiptFile, MIN_SNIFF_BYTES, type FileValidationResult } from '../domain/validation';

export interface IntakeSuccess {
  readonly ok: true;
  readonly fileUri: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export type IntakeResult = IntakeSuccess | Extract<FileValidationResult, { ok: false }>;

/**
 * A short, monotonically increasing token that makes each intake's filename
 * distinct. Only needs to differ from the previous intake of the same draft,
 * which a millisecond clock plus a counter gives comfortably — this is the I/O
 * layer, so a real clock is fine here in a way it would not be in the domain.
 */
let intakeCounter = 0;
function intakeDiscriminator(): string {
  intakeCounter += 1;
  return `${Date.now().toString(36)}${intakeCounter.toString(36)}`;
}

/** Extension for a normalized mime, so the stored copy is self-describing on disk. */
function extensionFor(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    case 'image/webp': return 'webp';
    case 'application/pdf': return 'pdf';
    default: return 'bin';
  }
}

/**
 * Copy a picked file into app storage and validate it.
 * `localId` scopes the filename so two drafts can never collide.
 */
export async function intakeFile(
  sourceUri: string,
  localId: string,
  declaredMime: string | null,
  declaredName: string | null,
): Promise<IntakeResult> {
  const { Directory, File, Paths } = await import('expo-file-system');

  const receipts = new Directory(Paths.document, 'receipts');
  if (!receipts.exists) receipts.create({ intermediates: true });

  const source = new File(sourceUri);

  // Read the header BEFORE copying so a file we are going to reject never
  // occupies disk space in our sandbox.
  let magicBytes: Uint8Array | null = null;
  try {
    const all = await source.bytes();
    magicBytes = all.slice(0, Math.max(MIN_SNIFF_BYTES, 16));
  } catch {
    // Some providers refuse a read until the file is materialised. The
    // validator has an explicit degraded path for a null header.
    magicBytes = null;
  }

  const sizeBytes = source.size ?? 0;
  const fileName = declaredName ?? sourceUri.split('/').pop() ?? 'receipt';

  const verdict = validateReceiptFile({ fileName, declaredMime, sizeBytes, magicBytes });
  if (!verdict.ok) return verdict;

  // Our copy is named by us, never from the picker's filename, which is
  // untrusted and may contain traversal sequences.
  //
  // The name carries a per-intake discriminator as well as the localId. A fixed
  // `<localId>.<ext>` looked tidier and was a bug: picking a second image wrote
  // the same path, so `fileUri` came back byte-identical and React Native's
  // Image kept serving its cached copy. The file changed and the screen did
  // not. Nothing downstream needs a stable local filename — the server's
  // storage key is derived from (company, localId, mime), not from this.
  //
  // Any earlier copy for this draft is deleted first, so re-picking cannot
  // leave orphans behind in the sandbox.
  for (const entry of receipts.list()) {
    if (entry instanceof File && entry.name.startsWith(`${localId}.`)) entry.delete();
    else if (entry instanceof File && entry.name.startsWith(`${localId}-`)) entry.delete();
  }

  const target = new File(
    receipts,
    `${localId}-${intakeDiscriminator()}.${extensionFor(verdict.normalizedMime)}`,
  );
  if (target.exists) target.delete();
  source.copy(target);

  return {
    ok: true,
    fileUri: target.uri,
    fileName,
    mimeType: verdict.normalizedMime,
    sizeBytes: target.size ?? sizeBytes,
  };
}
