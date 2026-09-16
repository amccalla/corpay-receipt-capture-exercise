/**
 * Crop geometry. Pure, so it is tested directly; the native encode path around
 * it is not, which is stated plainly in the README rather than papered over.
 */

import {
  FULL_FRAME,
  isFullFrame,
  MIN_CROP_SIZE,
  rectToPixels,
  resizeByCorner,
  type Corner,
  type CropRect,
} from '../image-edit';

describe('rectToPixels', () => {
  it('maps a normalised rect onto source pixels', () => {
    expect(rectToPixels({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, 1000, 800)).toEqual({
      originX: 250,
      originY: 400,
      width: 500,
      height: 200,
    });
  });

  it('returns the whole image for a full-frame rect', () => {
    expect(rectToPixels(FULL_FRAME, 1000, 800)).toEqual({
      originX: 0,
      originY: 0,
      width: 1000,
      height: 800,
    });
  });

  describe('a rect is a request, not an instruction', () => {
    // A rectangle running past the edge makes the native manipulator throw, and
    // historically on some platforms read adjacent memory. Clamp, never trust.
    it.each<[string, CropRect]>([
      ['overflows the right edge', { x: 0.8, y: 0, width: 0.5, height: 1 }],
      ['overflows the bottom edge', { x: 0, y: 0.9, width: 1, height: 0.5 }],
      ['starts beyond the image', { x: 1.5, y: 1.5, width: 0.5, height: 0.5 }],
      ['has negative origin', { x: -0.5, y: -0.5, width: 0.5, height: 0.5 }],
      ['is absurdly oversized', { x: 0, y: 0, width: 99, height: 99 }],
    ])('stays inside the bounds when it %s', (_label, rect) => {
      const px = rectToPixels(rect, 1000, 800);

      expect(px.originX).toBeGreaterThanOrEqual(0);
      expect(px.originY).toBeGreaterThanOrEqual(0);
      expect(px.width).toBeGreaterThan(0);
      expect(px.height).toBeGreaterThan(0);
      // The decisive assertion: the far edge never exceeds the source.
      expect(px.originX + px.width).toBeLessThanOrEqual(1000);
      expect(px.originY + px.height).toBeLessThanOrEqual(800);
    });
  });

  it('never returns a zero-width or zero-height crop', () => {
    // A degenerate rect would produce an unusable image rather than an error,
    // so it is floored at one pixel.
    const px = rectToPixels({ x: 0.5, y: 0.5, width: 0, height: 0 }, 1000, 800);
    expect(px.width).toBeGreaterThanOrEqual(1);
    expect(px.height).toBeGreaterThanOrEqual(1);
  });

  it('handles a 1x1 source without collapsing', () => {
    const px = rectToPixels({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, 1, 1);
    expect(px.width).toBeGreaterThanOrEqual(1);
    expect(px.height).toBeGreaterThanOrEqual(1);
    expect(px.originX + px.width).toBeLessThanOrEqual(1);
  });
});

describe('isFullFrame', () => {
  it('recognises the full frame so the crop step can be skipped', () => {
    expect(isFullFrame(FULL_FRAME)).toBe(true);
    expect(isFullFrame({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
  });

  it('is false for any genuine crop', () => {
    expect(isFullFrame({ x: 0.1, y: 0, width: 1, height: 1 })).toBe(false);
    expect(isFullFrame({ x: 0, y: 0, width: 0.9, height: 1 })).toBe(false);
    expect(isFullFrame({ x: 0, y: 0, width: 1, height: 0.5 })).toBe(false);
  });
});

describe('resizeByCorner', () => {
  const base: CropRect = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };

  it('moves only the dragged corner, leaving the opposite edges fixed', () => {
    // Dragging the top-left in by 0.1 should move x and y, and shrink w and h
    // by the same amount — the right and bottom edges must not move.
    const r = resizeByCorner(base, 'tl', 0.1, 0.1);
    expect(r.x).toBeCloseTo(0.3);
    expect(r.y).toBeCloseTo(0.3);
    expect(r.x + r.width).toBeCloseTo(base.x + base.width);
    expect(r.y + r.height).toBeCloseTo(base.y + base.height);
  });

  it('moves the far edges when dragging the bottom-right, leaving the origin fixed', () => {
    const r = resizeByCorner(base, 'br', 0.1, 0.1);
    expect(r.x).toBeCloseTo(base.x);
    expect(r.y).toBeCloseTo(base.y);
    expect(r.width).toBeCloseTo(0.7);
    expect(r.height).toBeCloseTo(0.7);
  });

  it.each<[Corner]>([['tl'], ['tr'], ['bl'], ['br']])(
    'never shrinks below MIN_CROP_SIZE when %s is dragged far inward',
    (corner) => {
      // A big inward drag from every corner: the box must floor, not invert.
      const r = resizeByCorner(base, corner, 5, 5);
      expect(r.width).toBeGreaterThanOrEqual(MIN_CROP_SIZE - 1e-9);
      expect(r.height).toBeGreaterThanOrEqual(MIN_CROP_SIZE - 1e-9);
    },
  );

  it.each<[Corner]>([['tl'], ['tr'], ['bl'], ['br']])(
    'never leaves the 0..1 bounds when %s is dragged far outward',
    (corner) => {
      const r = resizeByCorner(base, corner, -5, -5);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-9);
    },
  );

  it('produces a rect that rectToPixels can always resolve safely', () => {
    // The two pure functions compose: whatever a drag produces must still map
    // to an in-bounds pixel rect. This is the property that matters, since the
    // native cropper throws on an out-of-range rectangle.
    for (const corner of ['tl', 'tr', 'bl', 'br'] as Corner[]) {
      for (const d of [-3, -0.4, -0.05, 0, 0.05, 0.4, 3]) {
        const r = resizeByCorner(base, corner, d, d);
        const px = rectToPixels(r, 1000, 800);
        expect(px.originX + px.width).toBeLessThanOrEqual(1000);
        expect(px.originY + px.height).toBeLessThanOrEqual(800);
        expect(px.width).toBeGreaterThan(0);
        expect(px.height).toBeGreaterThan(0);
      }
    }
  });

  it('is a no-op for a zero drag', () => {
    expect(resizeByCorner(base, 'tl', 0, 0)).toEqual(base);
  });
});
