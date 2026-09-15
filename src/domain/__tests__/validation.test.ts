import {
  ACCEPTED_MIME_TYPES,
  MAX_FILE_BYTES,
  PRODUCTION_QUARANTINE_BOUNDARY,
  isUnsafeFileName,
  safeStorageKey,
  sniffMimeFromMagicBytes,
  validateReceiptFile,
  type FileRejectionCode,
  type FileValidationResult,
  type ReceiptFileInput,
} from '../validation';

// ---------------------------------------------------------------------------
// Fixtures: byte headers, built by hand so the tests assert on real signatures
// rather than on whatever the module happens to believe today.
// ---------------------------------------------------------------------------

function ascii(text: string): number[] {
  return Array.from(text, (ch) => ch.charCodeAt(0));
}

const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0x00, 0x01]);
const PNG_HEADER = new Uint8Array([0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PDF_HEADER = new Uint8Array([...ascii('%PDF-1.7'), 0x0a, 0x25, 0xe2, 0xe3]);
const WEBP_HEADER = new Uint8Array([...ascii('RIFF'), 0x24, 0x10, 0x00, 0x00, ...ascii('WEBPVP8 ')]);

/** ISO-BMFF: 4-byte box size, 'ftyp', then the major brand at offset 8. */
function isoBmffHeader(brand: string): Uint8Array {
  return new Uint8Array([0x00, 0x00, 0x00, 0x20, ...ascii('ftyp'), ...ascii(brand), 0x00, 0x00, 0x00, 0x00]);
}

const HEIC_HEADER = isoBmffHeader('heic');

/** A Windows PE renamed to receipt.jpg: the whole point of sniffing. */
const EXECUTABLE_HEADER = new Uint8Array([...ascii('MZ'), 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);

/** A ZIP/Office/APK header - another thing a picker will happily call an image. */
const ZIP_HEADER = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00]);

const VALID_INPUT: ReceiptFileInput = {
  fileName: 'receipt.jpg',
  declaredMime: 'image/jpeg',
  sizeBytes: 120_000,
  magicBytes: JPEG_HEADER,
};

function input(overrides: Partial<ReceiptFileInput>): ReceiptFileInput {
  return { ...VALID_INPUT, ...overrides };
}

type OkResult = Extract<FileValidationResult, { ok: true }>;
type RejectedResult = Extract<FileValidationResult, { ok: false }>;

function expectOk(result: FileValidationResult): OkResult {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  }
  return result;
}

function expectRejected(result: FileValidationResult): RejectedResult {
  if (result.ok) {
    throw new Error(`expected a rejection, got ok (${result.normalizedMime})`);
  }
  return result;
}

// ---------------------------------------------------------------------------

describe('constants', () => {
  it('caps a receipt at 10 MiB', () => {
    expect(MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('accepts exactly the six receipt-bearing types', () => {
    expect(Array.from(ACCEPTED_MIME_TYPES).sort()).toEqual([
      'application/pdf',
      'image/heic',
      'image/heif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });
});

describe('sniffMimeFromMagicBytes', () => {
  it('identifies each accepted format from its signature', () => {
    expect(sniffMimeFromMagicBytes(JPEG_HEADER)).toBe('image/jpeg');
    expect(sniffMimeFromMagicBytes(PNG_HEADER)).toBe('image/png');
    expect(sniffMimeFromMagicBytes(PDF_HEADER)).toBe('application/pdf');
    expect(sniffMimeFromMagicBytes(WEBP_HEADER)).toBe('image/webp');
  });

  it.each([
    ['heic', 'image/heic'],
    ['heix', 'image/heic'],
    ['hevc', 'image/heic'],
    ['mif1', 'image/heif'],
    ['msf1', 'image/heif'],
  ])('reads ISO-BMFF brand %s as %s', (brand, expected) => {
    expect(sniffMimeFromMagicBytes(isoBmffHeader(brand))).toBe(expected);
  });

  it('rejects ISO-BMFF containers that are not HEIF stills', () => {
    // An MP4 and an AVIF are the same container shape with a different brand;
    // neither should be handed to the receipt image pipeline.
    expect(sniffMimeFromMagicBytes(isoBmffHeader('mp42'))).toBeNull();
    expect(sniffMimeFromMagicBytes(isoBmffHeader('avif'))).toBeNull();
    expect(sniffMimeFromMagicBytes(isoBmffHeader('isom'))).toBeNull();
  });

  it('returns null for formats we do not accept', () => {
    expect(sniffMimeFromMagicBytes(EXECUTABLE_HEADER)).toBeNull();
    expect(sniffMimeFromMagicBytes(ZIP_HEADER)).toBeNull();
    // GIF89a - a real image format, but not one we take.
    expect(sniffMimeFromMagicBytes(new Uint8Array(ascii('GIF89a______')))).toBeNull();
  });

  it('requires RIFF containers to actually be WEBP', () => {
    const wav = new Uint8Array([...ascii('RIFF'), 0x24, 0x10, 0x00, 0x00, ...ascii('WAVEfmt ')]);
    expect(sniffMimeFromMagicBytes(wav)).toBeNull();
  });

  it('returns null rather than reading past the end of a short buffer', () => {
    expect(sniffMimeFromMagicBytes(new Uint8Array([]))).toBeNull();
    expect(sniffMimeFromMagicBytes(new Uint8Array([0xff, 0xd8]))).toBeNull(); // JPEG needs 3
    expect(sniffMimeFromMagicBytes(PNG_HEADER.slice(0, 7))).toBeNull(); // PNG needs 8
    expect(sniffMimeFromMagicBytes(HEIC_HEADER.slice(0, 11))).toBeNull(); // brand needs 12
  });

  it('refuses a signature that is not at its exact offset (polyglot shape)', () => {
    // A PDF hiding behind a one-byte prefix: real readers accept this, we do
    // not, because "valid as two formats at once" is the attack.
    const offsetPdf = new Uint8Array([0x0a, ...ascii('%PDF-1.7'), 0x0a, 0x00, 0x00]);
    expect(sniffMimeFromMagicBytes(offsetPdf)).toBeNull();
  });
});

describe('isUnsafeFileName', () => {
  it.each([
    'receipt.jpg',
    'Lunch 2026-08-11.heic',
    'scan_001.pdf',
    'facture-café.png',
    'receipt (1).jpg',
  ])('accepts the ordinary name %s', (name) => {
    expect(isUnsafeFileName(name)).toBe(false);
  });

  it.each([
    ['relative traversal', '../../../etc/passwd'],
    ['traversal segment', 'a/../../b.jpg'],
    ['windows traversal', '..\\..\\windows\\system32\\config'],
    ['absolute posix path', '/etc/shadow'],
    ['absolute windows path', 'C:\\Users\\drew\\receipt.jpg'],
    ['bare drive letter', 'c:receipt.jpg'],
    ['UNC path', '\\\\attacker\\share\\x.jpg'],
    ['forward slash anywhere', 'folder/receipt.jpg'],
  ])('rejects %s', (_label, name) => {
    expect(isUnsafeFileName(name)).toBe(true);
  });

  it('rejects NUL bytes and control characters', () => {
    // The classic truncation trick: everything after the NUL is dropped by a
    // C-string consumer, so 'receipt.jpg\0.php' writes a .php file.
    expect(isUnsafeFileName('receipt.jpg\u0000.php')).toBe(true);
    expect(isUnsafeFileName('receipt\u000a.jpg')).toBe(true);
    expect(isUnsafeFileName('receipt\u007f.jpg')).toBe(true);
    expect(isUnsafeFileName('receipt\u0009.jpg')).toBe(true);
  });

  it('rejects bidi and invisible characters used to spoof an extension', () => {
    expect(isUnsafeFileName('receipt\u202Egpj.exe')).toBe(true);
    expect(isUnsafeFileName('receipt\u200b.jpg')).toBe(true);
    expect(isUnsafeFileName('\ufeffreceipt.jpg')).toBe(true);
  });

  it('rejects percent-encoded traversal in case a later layer decodes it', () => {
    expect(isUnsafeFileName('%2e%2e%2freceipt.jpg')).toBe(true);
    expect(isUnsafeFileName('receipt%00.php')).toBe(true);
    expect(isUnsafeFileName('a%5cb.jpg')).toBe(true);
  });

  it('rejects Windows reserved device names, with or without an extension', () => {
    expect(isUnsafeFileName('CON')).toBe(true);
    expect(isUnsafeFileName('con.jpg')).toBe(true);
    expect(isUnsafeFileName('NUL.pdf')).toBe(true);
    expect(isUnsafeFileName('lpt1.png')).toBe(true);
    expect(isUnsafeFileName('COM9.heic')).toBe(true);
    // Not reserved: the stem only matches the whole device word.
    expect(isUnsafeFileName('console.jpg')).toBe(false);
  });

  it('rejects trailing dots and padding whitespace that collide on Windows', () => {
    expect(isUnsafeFileName('receipt.jpg ')).toBe(true);
    expect(isUnsafeFileName(' receipt.jpg')).toBe(true);
    expect(isUnsafeFileName('receipt.jpg.')).toBe(true);
  });

  it('rejects empty, dot, dot-dot and over-long names', () => {
    expect(isUnsafeFileName('')).toBe(true);
    expect(isUnsafeFileName('.')).toBe(true);
    expect(isUnsafeFileName('..')).toBe(true);
    expect(isUnsafeFileName(`${'a'.repeat(252)}.jpg`)).toBe(true); // 256 chars
    expect(isUnsafeFileName(`${'a'.repeat(251)}.jpg`)).toBe(false); // 255 chars
  });
});

describe('validateReceiptFile - acceptance', () => {
  it('accepts a well-formed JPEG and reports the sniffed type', () => {
    const result = expectOk(validateReceiptFile(VALID_INPUT));
    expect(result.normalizedMime).toBe('image/jpeg');
    expect(result.sniffedMime).toBe('image/jpeg');
  });

  it('accepts a HEIC photo from an iPhone', () => {
    const result = expectOk(
      validateReceiptFile(
        input({ fileName: 'IMG_0042.HEIC', declaredMime: 'image/heic', magicBytes: HEIC_HEADER }),
      ),
    );
    expect(result.normalizedMime).toBe('image/heic');
  });

  it('treats a heic/heif label difference as agreement, not a mismatch', () => {
    // Both labels name the same container; rejecting honest iPhone uploads
    // over a label choice would be a bug, not security.
    const result = expectOk(
      validateReceiptFile(input({ declaredMime: 'image/heif', magicBytes: HEIC_HEADER })),
    );
    expect(result.normalizedMime).toBe('image/heic'); // the bytes still decide
  });

  it('accepts a Live Photo HEIC sequence declared as image/heic-sequence', () => {
    const result = expectOk(
      validateReceiptFile(
        input({ declaredMime: 'image/heic-sequence', magicBytes: isoBmffHeader('msf1') }),
      ),
    );
    expect(result.normalizedMime).toBe('image/heif');
  });

  it.each([
    ['image/jpg', 'image/jpeg'],
    ['IMAGE/JPEG', 'image/jpeg'],
    ['image/jpeg; charset=binary', 'image/jpeg'],
    ['  image/pjpeg  ', 'image/jpeg'],
  ])('normalises the declared type %s', (declared, expected) => {
    const result = expectOk(validateReceiptFile(input({ declaredMime: declared })));
    expect(result.normalizedMime).toBe(expected);
  });

  it('accepts a file with no declared type when the bytes identify it', () => {
    const result = expectOk(
      validateReceiptFile(input({ declaredMime: null, magicBytes: PDF_HEADER, fileName: 's.pdf' })),
    );
    expect(result.normalizedMime).toBe('application/pdf');
    expect(result.sniffedMime).toBe('application/pdf');
  });

  it('falls back to the declared type when no header could be read, and says so', () => {
    const result = expectOk(validateReceiptFile(input({ magicBytes: null })));
    expect(result.normalizedMime).toBe('image/jpeg');
    // sniffedMime === null is the signal that this file was never verified on
    // device; the server quarantine scan is the only check it will face.
    expect(result.sniffedMime).toBeNull();
  });
});

describe('validateReceiptFile - magic bytes beat the declared type', () => {
  it('rejects a PNG that claims to be a JPEG', () => {
    const result = expectRejected(validateReceiptFile(input({ magicBytes: PNG_HEADER })));
    expect(result.code).toBe('MAGIC_MISMATCH');
    expect(result.retryable).toBe(false);
  });

  it('never reclassifies to the declared type: the bytes are the answer', () => {
    // Declared PDF, actually a JPEG. Both are accepted types, so a lazy
    // implementation would let this through as a PDF.
    const result = expectRejected(
      validateReceiptFile(input({ declaredMime: 'application/pdf', magicBytes: JPEG_HEADER })),
    );
    expect(result.code).toBe('MAGIC_MISMATCH');
  });

  it('rejects an executable renamed to receipt.jpg', () => {
    const result = expectRejected(
      validateReceiptFile(input({ magicBytes: EXECUTABLE_HEADER })),
    );
    expect(result.code).toBe('MAGIC_MISMATCH');
    expect(result.retryable).toBe(false);
  });

  it('rejects an archive declared as a PDF', () => {
    const result = expectRejected(
      validateReceiptFile(
        input({ fileName: 'invoice.pdf', declaredMime: 'application/pdf', magicBytes: ZIP_HEADER }),
      ),
    );
    expect(result.code).toBe('MAGIC_MISMATCH');
  });

  it('fails closed when a header was requested but came back empty', () => {
    // A zero-length read from a non-empty file is a broken or hostile caller;
    // "unverifiable" must not mean "accepted".
    const result = expectRejected(
      validateReceiptFile(input({ magicBytes: new Uint8Array([]) })),
    );
    expect(result.code).toBe('MAGIC_MISMATCH');
  });

  it('rejects a file whose type cannot be established at all', () => {
    const result = expectRejected(
      validateReceiptFile(input({ declaredMime: null, magicBytes: null })),
    );
    expect(result.code).toBe('UNSUPPORTED_TYPE');
    expect(result.retryable).toBe(false);
  });
});

describe('validateReceiptFile - size boundary (brief edge case 4)', () => {
  it('accepts a file of exactly MAX_FILE_BYTES', () => {
    expectOk(validateReceiptFile(input({ sizeBytes: MAX_FILE_BYTES })));
  });

  it('rejects a file one byte over the limit', () => {
    const result = expectRejected(validateReceiptFile(input({ sizeBytes: MAX_FILE_BYTES + 1 })));
    expect(result.code).toBe('TOO_LARGE');
  });

  it('marks an oversized HEIC permanently failed so the sync engine stops retrying', () => {
    const result = expectRejected(
      validateReceiptFile(
        input({
          fileName: 'IMG_0042.HEIC',
          declaredMime: 'image/heic',
          magicBytes: HEIC_HEADER,
          sizeBytes: 11 * 1024 * 1024,
        }),
      ),
    );
    expect(result.code).toBe('TOO_LARGE');
    expect(result.retryable).toBe(false); // it will never get smaller by itself
    expect(result.message).toContain('10 MB');
  });

  it('rejects an empty file, but as a retryable condition', () => {
    const result = expectRejected(validateReceiptFile(input({ sizeBytes: 0 })));
    expect(result.code).toBe('EMPTY');
    // The sandbox copy may simply not have flushed yet - the same URI can
    // yield real bytes a moment later.
    expect(result.retryable).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'treats the nonsense size %p as unreadable rather than letting it through',
    (size) => {
      // NaN compares false against every bound, so without an explicit guard a
      // NaN size would pass the size check and be uploaded.
      const result = expectRejected(validateReceiptFile(input({ sizeBytes: size })));
      expect(result.code).toBe('EMPTY');
    },
  );
});

describe('validateReceiptFile - declared type and name', () => {
  it('rejects a type we do not accept without reading the bytes', () => {
    const result = expectRejected(
      validateReceiptFile(
        input({ fileName: 'clip.mp4', declaredMime: 'video/mp4', magicBytes: null }),
      ),
    );
    expect(result.code).toBe('UNSUPPORTED_TYPE');
    expect(result.retryable).toBe(false);
  });

  it.each(['image/gif', 'image/svg+xml', 'text/html', 'application/zip', ''])(
    'rejects the declared type %p',
    (declared) => {
      const result = expectRejected(validateReceiptFile(input({ declaredMime: declared })));
      expect(result.code).toBe('UNSUPPORTED_TYPE');
    },
  );

  it('rejects an unsafe name', () => {
    const result = expectRejected(
      validateReceiptFile(input({ fileName: '../../../etc/passwd' })),
    );
    expect(result.code).toBe('UNSAFE_NAME');
    expect(result.retryable).toBe(false);
  });

  it('checks the name before anything else', () => {
    // A hostile name plus an oversized, wrong-typed, empty file: the name wins,
    // because a client sending that name is not to be processed further.
    const result = expectRejected(
      validateReceiptFile({
        fileName: 'receipt.jpg\u0000.php',
        declaredMime: 'application/zip',
        sizeBytes: 0,
        magicBytes: ZIP_HEADER,
      }),
    );
    expect(result.code).toBe('UNSAFE_NAME');
  });

  it('checks emptiness before size and type', () => {
    const result = expectRejected(
      validateReceiptFile(input({ sizeBytes: 0, declaredMime: 'application/zip' })),
    );
    expect(result.code).toBe('EMPTY');
  });

  it('checks size before the declared type', () => {
    const result = expectRejected(
      validateReceiptFile(input({ sizeBytes: MAX_FILE_BYTES + 1, declaredMime: 'application/zip' })),
    );
    expect(result.code).toBe('TOO_LARGE');
  });
});

describe('rejection ergonomics', () => {
  const samples: ReadonlyArray<readonly [FileRejectionCode, ReceiptFileInput]> = [
    ['UNSAFE_NAME', input({ fileName: '../x.jpg' })],
    ['EMPTY', input({ sizeBytes: 0 })],
    ['TOO_LARGE', input({ sizeBytes: MAX_FILE_BYTES + 1 })],
    ['UNSUPPORTED_TYPE', input({ declaredMime: 'image/gif' })],
    ['MAGIC_MISMATCH', input({ magicBytes: ZIP_HEADER })],
  ];

  it('exercises every rejection code', () => {
    const produced = samples.map(([, sample]) => expectRejected(validateReceiptFile(sample)).code);
    expect(new Set(produced).size).toBe(samples.length);
  });

  it.each(samples)('%s yields an actionable, non-technical message', (code, sample) => {
    const result = expectRejected(validateReceiptFile(sample));
    expect(result.code).toBe(code);
    expect(result.message.length).toBeGreaterThan(20);
    // No jargon leaking into a user-facing string.
    expect(result.message).not.toMatch(/mime|magic byte|null|undefined|0x/i);
    expect(result.message).toMatch(/\b(take|retake|attach|rename|choose|split)\b/i);
  });

  it('only EMPTY is retryable: everything else is permanent for this file', () => {
    for (const [code, sample] of samples) {
      const result = expectRejected(validateReceiptFile(sample));
      expect(result.retryable).toBe(code === 'EMPTY');
    }
  });
});

describe('safeStorageKey', () => {
  it('is company-scoped and derives the extension from the validated type', () => {
    expect(safeStorageKey('co_acme', 'rcpt_01H9', 'image/jpeg')).toBe(
      'companies/co_acme/receipts/rcpt_01H9.jpg',
    );
    expect(safeStorageKey('co_acme', 'rcpt_01H9', 'application/pdf')).toBe(
      'companies/co_acme/receipts/rcpt_01H9.pdf',
    );
    expect(safeStorageKey('co_acme', 'rcpt_01H9', 'image/heic')).toBe(
      'companies/co_acme/receipts/rcpt_01H9.heic',
    );
  });

  it('never embeds the client file name', () => {
    // The signature takes no file name at all, and the shape is fixed: a
    // literal prefix, two vetted ids and an extension we chose. There is no
    // position in the key an untrusted string could occupy.
    const key = safeStorageKey('co_acme', 'rcpt_01H9', 'image/jpeg');
    expect(key).not.toContain(VALID_INPUT.fileName);
    expect(key).toMatch(/^companies\/[A-Za-z0-9_-]+\/receipts\/[A-Za-z0-9_-]+\.[a-z]+$/);
  });

  it('is stable across retries of the same draft, so a retry overwrites rather than duplicates', () => {
    // Brief edge case 1: the success response is lost and the client retries.
    expect(safeStorageKey('co_acme', 'rcpt_01H9', 'image/jpeg')).toBe(
      safeStorageKey('co_acme', 'rcpt_01H9', 'image/jpg'),
    );
  });

  it('keeps two companies in separate prefixes', () => {
    const a = safeStorageKey('co_acme', 'rcpt_1', 'image/png');
    const b = safeStorageKey('co_globex', 'rcpt_1', 'image/png');
    expect(a).not.toBe(b);
    expect(a.startsWith('companies/co_acme/')).toBe(true);
    expect(b.startsWith('companies/co_globex/')).toBe(true);
  });

  it.each([
    ['traversal in the company id', 'co_acme/../co_globex', 'rcpt_1'],
    ['dot segment in the company id', '..', 'rcpt_1'],
    ['dot in an id (blocks .. entirely)', 'co.acme', 'rcpt_1'],
    ['traversal in the local id', 'co_acme', '../../etc/passwd'],
    ['empty company id', '', 'rcpt_1'],
    ['empty local id', 'co_acme', ''],
    ['whitespace', 'co acme', 'rcpt_1'],
    ['NUL byte', 'co_acme\u0000', 'rcpt_1'],
    ['over-long id', 'c'.repeat(129), 'rcpt_1'],
  ])('throws rather than rewriting on %s', (_label, companyId, localId) => {
    expect(() => safeStorageKey(companyId, localId, 'image/jpeg')).toThrow(/safe key segment/);
  });

  it('refuses to mint a key for a type we never validated', () => {
    expect(() => safeStorageKey('co_acme', 'rcpt_1', 'image/gif')).toThrow(/unvalidated/);
    expect(() => safeStorageKey('co_acme', 'rcpt_1', 'text/html')).toThrow(/unvalidated/);
  });
});

describe('PRODUCTION_QUARANTINE_BOUNDARY', () => {
  it('documents the server-side controls this client check does not replace', () => {
    const doc = PRODUCTION_QUARANTINE_BOUNDARY.toLowerCase();
    for (const topic of [
      'quarantine',
      'pre-signed',
      'anti-virus',
      'polyglot',
      'transcode',
      'exif',
      'gps',
      'promote',
      'nothing is ever served from quarantine',
      'sha-256',
    ]) {
      expect(doc).toContain(topic);
    }
  });

  it('states plainly that the client check is not the security boundary', () => {
    expect(PRODUCTION_QUARANTINE_BOUNDARY).toMatch(/NOT a security control/);
  });
});
