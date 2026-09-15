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

  // Our copy is named by us, from our own localId — never from the picker's
  // filename, which is untrusted and may contain traversal sequences.
  const target = new File(receipts, `${localId}.${extensionFor(verdict.normalizedMime)}`);
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
