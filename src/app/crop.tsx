import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutRectangle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useApp } from '@/ui/app-context';
import { Banner, Button, Card, Muted, Row, SectionTitle } from '@/ui/components';
import {
  FULL_FRAME,
  processReceiptImage,
  resizeByCorner,
  type Corner,
  type CropRect,
} from '@/ui/image-edit';
import { usePalette } from '@/ui/theme';

/**
 * Manual crop.
 *
 * Gestures use React Native's built-in responder props rather than
 * PanResponder or Reanimated. The maths is trivial, and the responder props go
 * straight onto the handle views — so every ref read happens inside an event
 * handler, never during render. An earlier version built PanResponders in a
 * `useMemo` that closed over `rectRef.current`, which the `react-hooks/refs`
 * lint rule correctly rejected: reading a ref during render can silently miss
 * an update.
 *
 * The rectangle is stored NORMALISED (0..1) so it is independent of screen size
 * and image resolution — the same rect means the same crop on a phone and a
 * tablet.
 */

const HANDLE = 28;

const CORNER_LABEL: Record<Corner, string> = {
  tl: 'Top left',
  tr: 'Top right',
  bl: 'Bottom left',
  br: 'Bottom right',
};

interface Box {
  width: number;
  height: number;
  left: number;
  top: number;
}

export default function CropScreen() {
  const { localId } = useLocalSearchParams<{ localId: string }>();
  const router = useRouter();
  const p = usePalette();
  const { drafts, actions } = useApp();

  const draft = drafts.find((d) => d.localId === localId);

  const [container, setContainer] = useState<LayoutRectangle | null>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const [rect, setRect] = useState<CropRect>({ x: 0.06, y: 0.06, width: 0.88, height: 0.88 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  useEffect(() => {
    if (!draft?.fileUri) return;
    Image.getSize(
      draft.fileUri,
      (w, h) => setAspect(w / h),
      () => setAspect(1),
    );
  }, [draft?.fileUri]);

  /** The on-screen box the image actually occupies, letterboxing included. */
  const box: Box | null = useMemo(() => {
    if (!container || !aspect) return null;
    const { width: cw, height: ch } = container;
    const containerAspect = cw / ch;
    const width = aspect > containerAspect ? cw : ch * aspect;
    const height = aspect > containerAspect ? cw / aspect : ch;
    return { width, height, left: (cw - width) / 2, top: (ch - height) / 2 };
  }, [container, aspect]);

  // Mirrors of the latest values for the gesture handlers. Written in an effect
  // rather than during render, so nothing reads or writes a ref while React is
  // rendering.
  const rectRef = useRef(rect);
  const boxRef = useRef<Box | null>(box);
  useEffect(() => { rectRef.current = rect; }, [rect]);
  useEffect(() => { boxRef.current = box; }, [box]);

  const dragRef = useRef<{ corner: Corner; x: number; y: number; from: CropRect } | null>(null);

  const onGrant = useCallback((corner: Corner) => (e: GestureResponderEvent) => {
    dragRef.current = {
      corner,
      x: e.nativeEvent.pageX,
      y: e.nativeEvent.pageY,
      from: rectRef.current,
    };
  }, []);

  const onMove = useCallback((e: GestureResponderEvent) => {
    const drag = dragRef.current;
    const b = boxRef.current;
    if (!drag || !b) return;
    const dx = (e.nativeEvent.pageX - drag.x) / b.width;
    const dy = (e.nativeEvent.pageY - drag.y) / b.height;
    setRect(resizeByCorner(drag.from, drag.corner, dx, dy));
  }, []);

  const onRelease = useCallback(() => { dragRef.current = null; }, []);

  /**
   * Keyboard- and screen-reader-accessible nudge. A drag gesture is unusable
   * with VoiceOver, so each handle is an `adjustable` that responds to
   * increment/decrement as well as to touch.
   */
  const nudge = useCallback((corner: Corner, direction: 1 | -1) => {
    const step = 0.05 * direction;
    setRect((prev) => resizeByCorner(prev, corner, step, step));
  }, []);

  const apply = useCallback(async () => {
    if (!draft?.fileUri) return;
    setBusy(true);
    setError(null);
    try {
      const result = await processReceiptImage(draft.fileUri, rect, draft.localId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await actions.patchDraft(draft.localId, {
        fileUri: result.fileUri,
        fileMimeType: result.mimeType,
        fileSizeBytes: result.sizeBytes,
      });
      setSaved(result.savedBytes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not process that image.');
    } finally {
      setBusy(false);
    }
  }, [draft, rect, actions]);

  if (!draft?.fileUri) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: p.bg, padding: 16 }}>
        <Card>
          <Muted>There is no image on this receipt to crop.</Muted>
        </Card>
      </SafeAreaView>
    );
  }

  const shade = '#00000088';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={['bottom']}>
      <View
        style={{ flex: 1, margin: 16, borderRadius: 12, overflow: 'hidden', backgroundColor: p.surfaceAlt }}
        onLayout={(e) => setContainer(e.nativeEvent.layout)}
      >
        <Image
          source={{ uri: draft.fileUri }}
          style={{ width: '100%', height: '100%' }}
          resizeMode="contain"
          accessible
          accessibilityRole="image"
          accessibilityLabel="Receipt image being cropped"
        />

        {box ? (
          <>
            {/* Dimmed surround: four rectangles around the crop box. */}
            <View pointerEvents="none" style={{ position: 'absolute', left: box.left, top: box.top, width: box.width, height: rect.y * box.height, backgroundColor: shade }} />
            <View pointerEvents="none" style={{ position: 'absolute', left: box.left, top: box.top + (rect.y + rect.height) * box.height, width: box.width, height: (1 - rect.y - rect.height) * box.height, backgroundColor: shade }} />
            <View pointerEvents="none" style={{ position: 'absolute', left: box.left, top: box.top + rect.y * box.height, width: rect.x * box.width, height: rect.height * box.height, backgroundColor: shade }} />
            <View pointerEvents="none" style={{ position: 'absolute', left: box.left + (rect.x + rect.width) * box.width, top: box.top + rect.y * box.height, width: (1 - rect.x - rect.width) * box.width, height: rect.height * box.height, backgroundColor: shade }} />

            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: box.left + rect.x * box.width,
                top: box.top + rect.y * box.height,
                width: rect.width * box.width,
                height: rect.height * box.height,
                borderWidth: 2,
                borderColor: '#FFFFFF',
              }}
            />

            {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => {
              const left =
                box.left + (corner === 'tl' || corner === 'bl' ? rect.x : rect.x + rect.width) * box.width;
              const top =
                box.top + (corner === 'tl' || corner === 'tr' ? rect.y : rect.y + rect.height) * box.height;
              return (
                <View
                  key={corner}
                  onStartShouldSetResponder={() => true}
                  onMoveShouldSetResponder={() => true}
                  onResponderGrant={onGrant(corner)}
                  onResponderMove={onMove}
                  onResponderRelease={onRelease}
                  onResponderTerminate={onRelease}
                  accessible
                  accessibilityRole="adjustable"
                  accessibilityLabel={`${CORNER_LABEL[corner]} crop handle`}
                  accessibilityHint="Swipe up or down to move this corner"
                  accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                  onAccessibilityAction={(e) => {
                    if (e.nativeEvent.actionName === 'increment') nudge(corner, 1);
                    if (e.nativeEvent.actionName === 'decrement') nudge(corner, -1);
                  }}
                  style={{
                    position: 'absolute',
                    left: left - HANDLE / 2,
                    top: top - HANDLE / 2,
                    width: HANDLE,
                    height: HANDLE,
                    borderRadius: HANDLE / 2,
                    backgroundColor: '#FFFFFF',
                    borderWidth: 2,
                    borderColor: p.accent,
                  }}
                />
              );
            })}
          </>
        ) : null}
      </View>

      <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {saved !== null ? (
          <Banner tone="success">
            Cropped and compressed{saved > 0 ? `, saving ${Math.round(saved / 1024)} KB` : ''}.
          </Banner>
        ) : null}

        {busy ? <ActivityIndicator accessibilityLabel="Processing image" /> : null}

        <SectionTitle>Crop</SectionTitle>
        <Muted>
          Drag the corners to the edge of the paper. Cropping cuts upload size more than compression
          does, and keeps whatever else was on the table out of a document kept for years.
        </Muted>

        <Row gap={10}>
          <View style={{ flex: 1 }}>
            <Button title="Reset" variant="secondary" disabled={busy} onPress={() => setRect(FULL_FRAME)} />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title={saved !== null ? 'Done' : 'Apply crop'}
              disabled={busy}
              onPress={() => (saved !== null ? router.back() : void apply())}
            />
          </View>
        </Row>
        <Text style={{ color: p.textMuted, fontSize: 12, textAlign: 'center' }}>
          Output is always JPEG, so an unsupported HEIC never reaches the server.
        </Text>
      </View>
    </SafeAreaView>
  );
}
