/**
 * Cropping and compression for a captured receipt.
 *
 * THE NON-OBVIOUS PART: the output of a crop is a NEW FILE, and it goes back
 * through the same validation as the original. It is tempting to treat it as
 * trusted because we produced it — but "we produced it" is exactly the
 * assumption that lets a malformed source propagate downstream with a clean
 * bill of health. The manipulator is a native library being handed
 * attacker-influenced bytes; its output gets re-sniffed like anything else.
 *
 * WHY CROP AT ALL: a phone photo of a receipt is mostly table. Cropping to the
 * paper cuts upload size by more than compression does, which on a bad
 * connection is the difference between a queued receipt draining and timing
 * out. It also removes whatever else was on the table from a document the
 * company keeps for seven years.
 */

import { validateReceiptFile, MIN_SNIFF_BYTES, type FileValidationResult } from '../domain/validation';

/** Normalised crop rectangle, 0..1 relative to the source. Resolution-independent. */
export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const FULL_FRAME: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Longest edge of the stored image. 1600px keeps small print legible for a
 * human reviewer and for OCR, while cutting a 12-megapixel phone capture by
 * roughly an order of magnitude. Receipts are documents, not photographs —
 * there is nothing to be gained from the extra pixels.
 */
export const MAX_EDGE_PX = 1600;

/** JPEG quality. 0.7 is the usual knee: visible artefacts start below it. */
export const JPEG_QUALITY = 0.7;

export interface ProcessedImage {
  readonly ok: true;
  readonly fileUri: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Bytes saved versus the source, for the UI to report honestly. */
  readonly savedBytes: number;
}

export type ProcessImageResult = ProcessedImage | Extract<FileValidationResult, { ok: false }>;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Convert a normalised rect to source pixels, clamped to the image bounds.
 *
 * Clamping rather than trusting the caller matters: a crop rectangle that
 * extends past the edge makes the native manipulator throw, and on some
 * platforms it has historically read adjacent memory instead. A rect is a
 * request, not an instruction.
 */
export function rectToPixels(
  rect: CropRect,
  srcWidth: number,
  srcHeight: number,
): { originX: number; originY: number; width: number; height: number } {
  const x = clamp01(rect.x);
  const y = clamp01(rect.y);
  const w = clamp01(rect.width);
  const h = clamp01(rect.height);

  // The origin is pulled back far enough to leave at least one pixel. Clamping
  // only the far edge is not enough: an origin ON the edge leaves zero room,
  // and the one-pixel floor below would then push the rectangle back out of
  // bounds - which is the exact out-of-range crop this function exists to
  // prevent. Found by the degenerate-rect tests, not by reading the code.
  const originX = Math.min(Math.round(x * srcWidth), Math.max(0, srcWidth - 1));
  const originY = Math.min(Math.round(y * srcHeight), Math.max(0, srcHeight - 1));
  const width = Math.max(1, Math.min(Math.round(w * srcWidth), srcWidth - originX));
  const height = Math.max(1, Math.min(Math.round(h * srcHeight), srcHeight - originY));

  return { originX, originY, width, height };
}

/** True when the rect asks for the whole image, so the crop step can be skipped. */
export function isFullFrame(rect: CropRect): boolean {
  return rect.x <= 0 && rect.y <= 0 && rect.width >= 1 && rect.height >= 1;
}

/**
 * Crop, downscale and re-encode. Always produces JPEG: it is the one format
 * every backend accepts, which sidesteps the HEIC rejection path entirely
 * (the brief's edge case 4) rather than discovering it at upload time.
 */
export async function processReceiptImage(
  sourceUri: string,
  rect: CropRect,
  localId: string,
): Promise<ProcessImageResult> {
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const { File } = await import('expo-file-system');

  const sourceSize = (() => {
    try {
      return new File(sourceUri).size ?? 0;
    } catch {
      return 0;
    }
  })();

  const context = ImageManipulator.manipulate(sourceUri);
  // renderAsync first so the true source dimensions are known — a normalised
  // rect cannot be resolved to pixels without them.
  let ref = await context.renderAsync();

  if (!isFullFrame(rect)) {
    const px = rectToPixels(rect, ref.width, ref.height);
    context.crop(px);
    ref = await context.renderAsync();
  }

  const longestEdge = Math.max(ref.width, ref.height);
  if (longestEdge > MAX_EDGE_PX) {
    // Resize by the longest edge so portrait and landscape are treated alike
    // and the aspect ratio is preserved by the library.
    if (ref.width >= ref.height) context.resize({ width: MAX_EDGE_PX });
    else context.resize({ height: MAX_EDGE_PX });
    ref = await context.renderAsync();
  }

  const saved = await ref.saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG });

  // Re-validate OUR OWN output. See the header comment: producing a file is
  // not the same as knowing it is well-formed.
  const outFile = new File(saved.uri);
  let magicBytes: Uint8Array | null = null;
  try {
    magicBytes = (await outFile.bytes()).slice(0, Math.max(MIN_SNIFF_BYTES, 16));
  } catch {
    magicBytes = null;
  }
  const sizeBytes = outFile.size ?? 0;

  const verdict = validateReceiptFile({
    fileName: `${localId}.jpg`,
    declaredMime: 'image/jpeg',
    sizeBytes,
    magicBytes,
  });
  if (!verdict.ok) return verdict;

  return {
    ok: true,
    fileUri: saved.uri,
    mimeType: verdict.normalizedMime,
    sizeBytes,
    widthPx: saved.width,
    heightPx: saved.height,
    savedBytes: Math.max(0, sourceSize - sizeBytes),
  };
}

// ---------------------------------------------------------------------------
// Crop-handle geometry
// ---------------------------------------------------------------------------

/** Which corner of the crop box is being dragged. */
export type Corner = 'tl' | 'tr' | 'bl' | 'br';

/**
 * Smallest crop the box may shrink to, as a fraction of the image. Stops a
 * drag from collapsing the rectangle to nothing, which would produce an
 * unusable image rather than an error the user could understand.
 */
export const MIN_CROP_SIZE = 0.12;

const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Resize `rect` by dragging `corner` a normalised (dx, dy).
 *
 * Each corner moves its own two edges; the opposite edges stay fixed, which is
 * what makes the box resize rather than translate. Pure, so the arithmetic is
 * tested directly instead of through a gesture.
 */
export function resizeByCorner(rect: CropRect, corner: Corner, dx: number, dy: number): CropRect {
  let { x, y, width, height } = rect;

  if (corner === 'tl' || corner === 'bl') {
    const nx = clampTo(rect.x + dx, 0, rect.x + rect.width - MIN_CROP_SIZE);
    width = rect.width + (rect.x - nx);
    x = nx;
  } else {
    width = clampTo(rect.width + dx, MIN_CROP_SIZE, 1 - rect.x);
  }

  if (corner === 'tl' || corner === 'tr') {
    const ny = clampTo(rect.y + dy, 0, rect.y + rect.height - MIN_CROP_SIZE);
    height = rect.height + (rect.y - ny);
    y = ny;
  } else {
    height = clampTo(rect.height + dy, MIN_CROP_SIZE, 1 - rect.y);
  }

  return { x, y, width, height };
}
