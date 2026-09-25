import {
  DEFAULT_OCR_SEED,
  LOW_CONFIDENCE_THRESHOLD,
  extractFromReceipt,
  isLowConfidence,
  type OcrResult,
} from '../ocr';

/** A deterministic corpus of storage keys to sample the extractor's behaviour. */
const KEYS: string[] = Array.from({ length: 300 }, (_, i) => `receipts/blob-${i}.jpg`);

/**
 * True only for a real calendar date. Constructing a Date from a fixed string
 * reads no ambient clock, so this stays deterministic.
 */
function isRealDateOnly(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parsed = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s;
}

function nullCount(r: OcrResult): number {
  return [r.vendor, r.amountMinorUnits, r.currency, r.transactionDate].filter((v) => v === null)
    .length;
}

function complete(confidence: number): OcrResult {
  return {
    vendor: 'Blue Bottle Coffee',
    amountMinorUnits: 4250,
    currency: 'USD',
    transactionDate: '2026-08-11',
    confidence,
  };
}

describe('extractFromReceipt — determinism', () => {
  it('returns byte-identical results for the same key, every time', () => {
    for (const key of KEYS) {
      expect(extractFromReceipt(key)).toEqual(extractFromReceipt(key));
    }
  });

  it('is stable across an explicit default seed and an omitted one', () => {
    for (const key of KEYS.slice(0, 50)) {
      expect(extractFromReceipt(key, { seed: DEFAULT_OCR_SEED })).toEqual(extractFromReceipt(key));
    }
  });

  it('produces a different world for a different seed', () => {
    // Not every key must differ — only that the seed is actually consumed.
    const differing = KEYS.filter(
      (k) => JSON.stringify(extractFromReceipt(k, { seed: 7 })) !== JSON.stringify(extractFromReceipt(k)),
    );
    expect(differing.length).toBeGreaterThan(KEYS.length / 2);
  });

  it('handles degenerate keys without throwing and still deterministically', () => {
    const odd = ['', ' ', '../../etc/passwd', '\u{1F9FE} receipt', 'x'.repeat(4096)];
    for (const key of odd) {
      const a = extractFromReceipt(key);
      expect(a).toEqual(extractFromReceipt(key));
      expect(a.confidence).toBeGreaterThanOrEqual(0);
      expect(a.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('gives different keys different readings (it is not a constant function)', () => {
    const distinct = new Set(KEYS.map((k) => JSON.stringify(extractFromReceipt(k))));
    expect(distinct.size).toBeGreaterThan(KEYS.length / 2);
  });
});

describe('extractFromReceipt — value semantics', () => {
  it('reports confidence in 0..1, quantized to two decimals', () => {
    for (const key of KEYS) {
      const { confidence } = extractFromReceipt(key);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
      // No floating dust: the value must survive a round trip through 2dp,
      // so 0.8300000000000001 would fail here.
      expect(confidence).toBe(Math.round(confidence * 100) / 100);
      expect(String(confidence).replace('0.', '').length).toBeLessThanOrEqual(2);
    }
  });

  it('reports amounts as non-negative integer MINOR units, never decimals', () => {
    for (const key of KEYS) {
      const { amountMinorUnits } = extractFromReceipt(key);
      if (amountMinorUnits === null) continue;
      expect(Number.isSafeInteger(amountMinorUnits)).toBe(true);
      expect(amountMinorUnits).toBeGreaterThan(0);
    }
  });

  it('shapes the amount to the currency exponent — JPY minor units are whole yen', () => {
    let sawJpy = false;
    let sawTwoDecimal = false;
    for (const key of KEYS) {
      const r = extractFromReceipt(key);
      if (r.currency === null || r.amountMinorUnits === null) continue;
      if (r.currency === 'JPY') {
        sawJpy = true;
        // Y150..Y10,000 — a zero-decimal range. If this module were quietly
        // emitting "cents" for JPY the ceiling would be 100x higher.
        expect(r.amountMinorUnits).toBeGreaterThanOrEqual(150);
        expect(r.amountMinorUnits).toBeLessThanOrEqual(10000);
      } else {
        sawTwoDecimal = true;
        expect(r.amountMinorUnits).toBeGreaterThanOrEqual(199);
        expect(r.amountMinorUnits).toBeLessThanOrEqual(25000);
      }
    }
    expect(sawJpy).toBe(true);
    expect(sawTwoDecimal).toBe(true);
  });

  it('emits only uppercase ISO 4217 codes it can actually justify', () => {
    const seen = new Set<string>();
    for (const key of KEYS) {
      const { currency } = extractFromReceipt(key);
      if (currency !== null) seen.add(currency);
    }
    expect([...seen].sort()).toEqual(['EUR', 'JPY', 'USD']);
  });

  it('emits transactionDate as a real, timezone-free calendar date', () => {
    let seen = 0;
    for (const key of KEYS) {
      const { transactionDate } = extractFromReceipt(key);
      if (transactionDate === null) continue;
      seen += 1;
      expect(isRealDateOnly(transactionDate)).toBe(true);
      // No instant smuggled in as a date.
      expect(transactionDate).not.toContain('T');
      expect(transactionDate).not.toContain('Z');
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('emits non-empty vendor strings when it emits one at all', () => {
    for (const key of KEYS) {
      const { vendor } = extractFromReceipt(key);
      if (vendor === null) continue;
      expect(typeof vendor).toBe('string');
      expect(vendor.length).toBeGreaterThan(0);
    }
  });
});

describe('extractFromReceipt — uncertainty is reachable on demand', () => {
  it('produces both trustworthy and untrustworthy readings', () => {
    const low = KEYS.filter((k) => isLowConfidence(extractFromReceipt(k)));
    const high = KEYS.filter((k) => !isLowConfidence(extractFromReceipt(k)));
    // Both branches must be reachable, or needsReview / confirmed could never
    // both be exercised by the app.
    expect(low.length).toBeGreaterThan(10);
    expect(high.length).toBeGreaterThan(10);
  });

  it('produces readings with missing fields, including a missing currency', () => {
    const results = KEYS.map((k) => extractFromReceipt(k));
    expect(results.some((r) => r.vendor === null)).toBe(true);
    expect(results.some((r) => r.amountMinorUnits === null)).toBe(true);
    // The nastiest real case: a legible total whose currency symbol is not.
    expect(results.some((r) => r.currency === null && r.amountMinorUnits !== null)).toBe(true);
    expect(results.some((r) => r.transactionDate === null)).toBe(true);
    expect(results.some((r) => nullCount(r) === 0)).toBe(true);
  });

  it('drops more fields as confidence falls — the number means something', () => {
    // Buckets straddle LOW_CONFIDENCE_THRESHOLD rather than sitting at 0.5 and
    // 0.9. Confidence is deliberately floored well above zero: a uniform draw
    // kept only half the fields on average, so a quarter of receipts read as
    // nothing and the capture screen looked broken rather than uncertain.
    // The correlation being asserted is unchanged; only the range moved.
    const results = KEYS.map((k) => extractFromReceipt(k));
    const lowBucket = results.filter((r) => r.confidence < LOW_CONFIDENCE_THRESHOLD);
    const highBucket = results.filter((r) => r.confidence >= 0.95);
    expect(lowBucket.length).toBeGreaterThan(0);
    expect(highBucket.length).toBeGreaterThan(0);

    const mean = (rs: OcrResult[]): number =>
      rs.reduce((acc, r) => acc + nullCount(r), 0) / rs.length;
    expect(mean(lowBucket)).toBeGreaterThan(mean(highBucket));
  });

  it('reads a receipt as entirely blank only rarely', () => {
    // The capture screen pre-fills from this, and a reading with nothing in it
    // is indistinguishable to a user from the feature being broken. A real
    // extractor can fail completely, so this is not forbidden — it is held
    // rare (measured at roughly 1 in 500) and the capture screen says plainly
    // when it happens rather than leaving the form mysteriously empty.
    const N = 2000;
    let blank = 0;
    for (let i = 0; i < N; i++) {
      if (nullCount(extractFromReceipt(`companies/acme/receipts/rcp_${i}.jpg`)) === 4) blank++;
    }
    expect(blank / N).toBeLessThan(0.02);
  });

  it('still leaves a real share of readings uncertain', () => {
    // Skewing toward usable must not make needsReview unreachable by chance.
    // It is also injectable on the server for on-demand demonstration.
    const results = KEYS.map((k) => extractFromReceipt(k));
    const uncertain = results.filter((r) => isLowConfidence(r)).length;
    expect(uncertain).toBeGreaterThan(0);
    expect(uncertain).toBeLessThan(results.length);
  });
});

describe('isLowConfidence', () => {
  it('treats the threshold itself as good enough (boundary)', () => {
    expect(isLowConfidence(complete(LOW_CONFIDENCE_THRESHOLD))).toBe(false);
    // One quantization step below.
    expect(isLowConfidence(complete(LOW_CONFIDENCE_THRESHOLD - 0.01))).toBe(true);
  });

  it('flags a perfect-confidence reading that is missing a field', () => {
    expect(isLowConfidence({ ...complete(1), vendor: null })).toBe(true);
    expect(isLowConfidence({ ...complete(1), amountMinorUnits: null })).toBe(true);
    expect(isLowConfidence({ ...complete(1), currency: null })).toBe(true);
    expect(isLowConfidence({ ...complete(1), transactionDate: null })).toBe(true);
  });

  it('accepts a complete, confident reading', () => {
    expect(isLowConfidence(complete(1))).toBe(false);
    expect(isLowConfidence(complete(0.99))).toBe(false);
  });

  it('flags everything at zero confidence', () => {
    expect(isLowConfidence(complete(0))).toBe(true);
  });

  it('does not treat a zero amount as a missing amount', () => {
    // 0 is falsy; a truthiness check here would wrongly demand review for a
    // legitimately free item.
    expect(isLowConfidence({ ...complete(1), amountMinorUnits: 0 })).toBe(false);
  });
});
