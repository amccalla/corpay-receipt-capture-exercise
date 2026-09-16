import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { decodeBarcodePayload, type BarcodeExtraction } from '@/domain/barcode';
import { formatDateOnlyHuman } from '@/domain/dates';
import { mergeExtraction, type MergeFieldOutcome } from '@/domain/extraction';
import { formatMinorUnits } from '@/domain/money';
import { useApp } from '@/ui/app-context';
import { Banner, Button, Card, Muted, Row, SectionTitle, Title } from '@/ui/components';
import { usePalette } from '@/ui/theme';

/**
 * Barcode / QR capture.
 *
 * The camera's only job is to produce a payload string. Every bit of meaning is
 * derived by the pure decoder in `domain/barcode.ts`, and every write to the
 * draft goes through `mergeExtraction`, which enforces the provenance rules.
 * There is deliberately no path from here that writes a field directly — that
 * is what keeps the brief's edge case 5 true no matter what the camera sees.
 */
export default function ScanScreen() {
  const { localId } = useLocalSearchParams<{ localId: string }>();
  const router = useRouter();
  const p = usePalette();
  const { drafts, actions } = useApp();

  const [permission, requestPermission] = useCameraPermissions();
  const [extraction, setExtraction] = useState<BarcodeExtraction | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<MergeFieldOutcome[] | null>(null);

  // A camera fires this continuously while a code is in frame. Without a latch
  // we would re-decode dozens of times a second and re-render the whole screen.
  const latched = useRef(false);

  const draft = drafts.find((d) => d.localId === localId);

  const onScanned = useCallback((result: BarcodeScanningResult) => {
    if (latched.current) return;
    latched.current = true;

    const decoded = decodeBarcodePayload(result.data);
    if (!decoded.ok) {
      setDecodeError(decoded.reason);
      setExtraction(null);
      return;
    }
    setDecodeError(null);
    setExtraction(decoded.extraction);
  }, []);

  const rescan = useCallback(() => {
    latched.current = false;
    setExtraction(null);
    setDecodeError(null);
    setOutcomes(null);
  }, []);

  const apply = useCallback(async () => {
    if (!draft || !extraction) return;
    const result = mergeExtraction(
      draft,
      {
        vendor: extraction.vendor,
        amountMinorUnits: extraction.amountMinorUnits,
        currency: extraction.currency,
        transactionDate: extraction.transactionDate,
      },
      'barcode',
      new Date().toISOString(),
    );
    setOutcomes([...result.outcomes]);
    if (result.changed) {
      await actions.patchDraft(draft.localId, {
        vendor: result.draft.vendor,
        amountMinorUnits: result.draft.amountMinorUnits,
        currency: result.draft.currency,
        transactionDate: result.draft.transactionDate,
        provenance: result.draft.provenance,
      });
    }
  }, [draft, extraction, actions]);

  if (!draft) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: p.bg, padding: 16 }}>
        <Card>
          <Title>Receipt not available</Title>
          <View style={{ height: 6 }} />
          <Muted>This receipt is not visible under the company you are signed in to.</Muted>
        </Card>
      </SafeAreaView>
    );
  }

  if (!permission) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: p.bg, padding: 16 }}>
        <Muted>Checking camera access…</Muted>
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: p.bg, padding: 16, gap: 12 }}>
        <Card>
          <Title>Camera access needed</Title>
          <View style={{ height: 6 }} />
          <Muted>
            Scanning reads the barcode or QR code printed on a receipt to fill in the vendor, amount
            and date. Anything you have already typed yourself is kept — a scan never overwrites your
            own corrections.
          </Muted>
          <View style={{ height: 12 }} />
          {permission.canAskAgain ? (
            <Button title="Allow camera" onPress={() => void requestPermission()} />
          ) : (
            <Banner tone="warning">
              Camera access was declined. Enable it for this app in your device settings to scan.
            </Banner>
          )}
        </Card>
        <Button title="Enter details by hand instead" variant="secondary" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={['bottom']}>
      {!extraction && !decodeError ? (
        <View style={{ flex: 1 }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{
              // Receipts carry these in practice: QR for fiscal invoices, and
              // the 1D families for retail and logistics labels.
              barcodeTypes: ['qr', 'code128', 'ean13', 'ean8', 'upc_a', 'upc_e', 'pdf417', 'itf14'],
            }}
            onBarcodeScanned={onScanned}
            accessibilityLabel="Camera viewfinder for scanning a receipt barcode"
          />
          <View style={{ padding: 16, gap: 10 }}>
            <Muted>Point the camera at the barcode or QR code on the receipt.</Muted>
            <Button title="Cancel" variant="secondary" onPress={() => router.back()} />
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
          {decodeError ? (
            <>
              <Banner tone="warning">{decodeError}</Banner>
              <Muted>
                Not every barcode carries expense data — many identify a product or a store, not a
                total. You can still enter the details by hand.
              </Muted>
            </>
          ) : null}

          {extraction ? (
            <>
              <Card>
                <SectionTitle>Scanned</SectionTitle>
                <Title>
                  {extraction.format === 'gs1-128'
                    ? 'GS1 barcode'
                    : extraction.format === 'fiscal-qr'
                      ? 'Fiscal invoice QR'
                      : 'Unrecognised code'}
                </Title>
                <View style={{ height: 10 }} />
                <ReadField label="Vendor" value={extraction.vendor} />
                <ReadField
                  label="Amount"
                  value={
                    extraction.amountMinorUnits !== null && extraction.currency
                      ? `${extraction.currency} ${formatMinorUnits(extraction.amountMinorUnits, extraction.currency)}`
                      : null
                  }
                />
                <ReadField
                  label="Date"
                  value={extraction.transactionDate ? formatDateOnlyHuman(extraction.transactionDate) : null}
                />
              </Card>

              {extraction.warnings.length > 0 ? (
                <Card>
                  <SectionTitle>Not used</SectionTitle>
                  {extraction.warnings.map((w) => (
                    <Text key={w} style={{ color: p.textMuted, fontSize: 13, lineHeight: 19, marginTop: 4 }}>
                      • {w}
                    </Text>
                  ))}
                </Card>
              ) : null}

              {outcomes ? (
                <Card>
                  <SectionTitle>Applied</SectionTitle>
                  {outcomes.map((o) => (
                    <Text
                      key={o.field}
                      style={{
                        color: o.applied ? p.success : p.textMuted,
                        fontSize: 13,
                        lineHeight: 19,
                        marginTop: 4,
                      }}
                    >
                      {o.applied
                        ? `${o.field}: set to ${o.value}`
                        : o.reason === 'HELD_BY_HIGHER_PRECEDENCE'
                          ? `${o.field}: kept your own entry`
                          : o.reason === 'INVALID_VALUE'
                            ? `${o.field}: the scanned value was not usable`
                            : `${o.field}: nothing on the code`}
                    </Text>
                  ))}
                </Card>
              ) : null}

              <View style={{ gap: 10 }}>
                {outcomes ? (
                  <Button title="Done" onPress={() => router.back()} />
                ) : (
                  <Button title="Use these details" onPress={() => void apply()} />
                )}
                <Button title="Scan again" variant="secondary" onPress={rescan} />
              </View>
            </>
          ) : (
            <Button title="Scan again" variant="secondary" onPress={rescan} />
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function ReadField({ label, value }: { label: string; value: string | null }) {
  const p = usePalette();
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 5 }}>
      <Text style={{ color: p.textMuted, fontSize: 13 }}>{label}</Text>
      <Text style={{ color: value ? p.text : p.textMuted, fontSize: 14, fontWeight: value ? '700' : '400' }}>
        {value ?? 'not on this code'}
      </Text>
    </Row>
  );
}
