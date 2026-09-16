import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Image, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isValidDateOnly } from '@/domain/dates';
import { provenanceForUserEntry } from '@/domain/extraction';
import { parseAmountToMinorUnits } from '@/domain/money';
import type { ReceiptDraft } from '@/domain/types';
import { useApp } from '@/ui/app-context';
import { Banner, Button, Card, Muted, Row, SectionTitle } from '@/ui/components';
import { intakeFile } from '@/ui/file-intake';
import { usePalette } from '@/ui/theme';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY'];

export default function CaptureScreen() {
  const router = useRouter();
  const p = usePalette();
  const { actions, networkMode } = useApp();

  const [draft, setDraft] = useState<ReceiptDraft | null>(null);
  const [vendor, setVendor] = useState('');
  const [amountText, setAmountText] = useState('');
  const [currency, setCurrency] = useState('USD');
  // Accepting the default is not the same event as choosing a currency, and
  // recording them identically would lock an unconsidered 'USD' in as a human
  // decision that no later barcode or OCR pass could correct.
  const [currencyChosen, setCurrencyChosen] = useState(false);
  const [dateText, setDateText] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const ensureDraft = useCallback(async (): Promise<ReceiptDraft | null> => {
    if (draft) return draft;
    const created = await actions.createDraft();
    setDraft(created);
    return created;
  }, [draft, actions]);

  const pick = useCallback(
    async (source: 'camera' | 'library') => {
      setBusy(true);
      setFileError(null);
      try {
        const ImagePicker = await import('expo-image-picker');

        const perm =
          source === 'camera'
            ? await ImagePicker.requestCameraPermissionsAsync()
            : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          setFileError(
            source === 'camera'
              ? 'Camera access is off. Enable it in Settings to photograph a receipt.'
              : 'Photo access is off. Enable it in Settings to choose a receipt.',
          );
          return;
        }

        const result =
          source === 'camera'
            ? await ImagePicker.launchCameraAsync({ quality: 0.8, exif: false })
            : await ImagePicker.launchImageLibraryAsync({ quality: 0.8, exif: false });
        if (result.canceled) return;

        const asset = result.assets[0];
        const d = await ensureDraft();
        if (!d) return;

        const intake = await intakeFile(asset.uri, d.localId, asset.mimeType ?? null, asset.fileName ?? null);
        if (!intake.ok) {
          setFileError(intake.message);
          return;
        }

        await actions.patchDraft(d.localId, {
          fileUri: intake.fileUri,
          fileName: intake.fileName,
          fileMimeType: intake.mimeType,
          fileSizeBytes: intake.sizeBytes,
        });
        setDraft({ ...d, fileUri: intake.fileUri, fileName: intake.fileName, fileMimeType: intake.mimeType, fileSizeBytes: intake.sizeBytes });
      } catch (err) {
        setFileError(err instanceof Error ? err.message : 'Could not read that file.');
      } finally {
        setBusy(false);
      }
    },
    [actions, ensureDraft],
  );

  const amountParse = amountText.trim() ? parseAmountToMinorUnits(amountText, currency) : null;
  const amountError = amountParse && !amountParse.ok ? amountParse.error : null;
  const dateError = dateText.trim() && !isValidDateOnly(dateText.trim()) ? 'Use YYYY-MM-DD.' : null;

  const canSave = !!draft?.fileUri && !!vendor.trim() && amountParse?.ok === true && !dateError && !!dateText.trim();

  const save = useCallback(
    async (submit: boolean) => {
      const d = draft;
      if (!d || !amountParse?.ok) return;
      setBusy(true);
      try {
        await actions.patchDraft(d.localId, {
          vendor: vendor.trim(),
          amountMinorUnits: amountParse.minorUnits,
          currency,
          transactionDate: dateText.trim(),
          notes: notes.trim() || null,
          // Marks ONLY the fields the person actually supplied. See
          // provenanceForUserEntry for why a blanket 'user' stamp is wrong.
          provenance: provenanceForUserEntry({
            vendor: vendor.trim(),
            amountMinorUnits: amountParse.minorUnits,
            currencyChosen,
            transactionDate: dateText.trim(),
          }),
        });

        if (submit) {
          const outcome = await actions.submitDraft(d.localId);
          if (outcome?.kind === 'failed') {
            Alert.alert('Not accepted', outcome.draft.lastError ?? 'The server rejected this receipt.');
          }
        }
        router.back();
      } finally {
        setBusy(false);
      }
    },
    [draft, amountParse, vendor, currency, currencyChosen, dateText, notes, actions, router],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={['bottom']}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
        <Card>
          <SectionTitle>Receipt image</SectionTitle>
          {draft?.fileUri ? (
            <View style={{ gap: 10 }}>
              <Image
                source={{ uri: draft.fileUri }}
                style={{ width: '100%', height: 200, borderRadius: 8, backgroundColor: p.surfaceAlt }}
                resizeMode="contain"
                accessibilityLabel="Selected receipt image"
              />
              <Muted>
                {draft.fileMimeType} · {Math.round((draft.fileSizeBytes ?? 0) / 1024)} KB · copied into app storage
              </Muted>
            </View>
          ) : (
            <Muted>
              No image yet. The file is copied into this app&apos;s own storage and checked before it
              is accepted — the picker&apos;s claimed type is not trusted.
            </Muted>
          )}

          {fileError ? (
            <View style={{ marginTop: 10 }}>
              <Banner tone="danger">{fileError}</Banner>
            </View>
          ) : null}

          <Row gap={10} style={{ marginTop: 12 }}>
            <View style={{ flex: 1 }}>
              <Button title="Camera" variant="secondary" disabled={busy} onPress={() => void pick('camera')} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Choose file" variant="secondary" disabled={busy} onPress={() => void pick('library')} />
            </View>
          </Row>

          {draft?.fileUri ? (
            <Row gap={10} style={{ marginTop: 10 }}>
              <View style={{ flex: 1 }}>
                <Button
                  title="Crop"
                  variant="secondary"
                  disabled={busy}
                  onPress={() => router.push(`/crop?localId=${draft.localId}`)}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  title="Scan code"
                  variant="secondary"
                  disabled={busy}
                  onPress={() => router.push(`/scan?localId=${draft.localId}`)}
                />
              </View>
            </Row>
          ) : null}
        </Card>

        <Card>
          <SectionTitle>Details</SectionTitle>
          <Field label="Vendor" value={vendor} onChangeText={setVendor} placeholder="Blue Bottle Coffee" />

          <Row gap={10} style={{ alignItems: 'flex-start' }}>
            <View style={{ flex: 2 }}>
              <Field
                label="Amount"
                value={amountText}
                onChangeText={setAmountText}
                placeholder="19.99"
                keyboardType="decimal-pad"
                error={amountError}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: p.textMuted, marginBottom: 6, marginTop: 4 }}>
                CURRENCY
              </Text>
              <Row gap={4} style={{ flexWrap: 'wrap' }}>
                {CURRENCIES.map((c) => (
                  <Text
                    key={c}
                    onPress={() => {
                      setCurrency(c);
                      setCurrencyChosen(true);
                    }}
                    style={{
                      paddingVertical: 6, paddingHorizontal: 9, borderRadius: 6, overflow: 'hidden',
                      backgroundColor: c === currency ? p.accent : p.surfaceAlt,
                      color: c === currency ? p.accentText : p.text,
                      fontWeight: '700', fontSize: 12,
                    }}
                  >
                    {c}
                  </Text>
                ))}
              </Row>
            </View>
          </Row>

          <Field
            label="Transaction date"
            value={dateText}
            onChangeText={setDateText}
            placeholder="2026-08-11"
            error={dateError}
            hint="The calendar date printed on the receipt. No timezone is applied to it."
          />
          <Field label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Client lunch" multiline />
        </Card>

        {busy ? <ActivityIndicator /> : null}

        <View style={{ gap: 10 }}>
          <Button
            title={networkMode === 'offline' ? 'Save and queue' : 'Save and submit'}
            disabled={!canSave || busy}
            onPress={() => void save(true)}
          />
          <Button title="Save as draft" variant="secondary" disabled={!canSave || busy} onPress={() => void save(false)} />
        </View>

        <Muted>
          {networkMode === 'offline'
            ? 'You are offline. This will be stored on the device and sent when you are back online — it will not be reported as confirmed until the server says so.'
            : 'This will be sent to the server now. It is only marked confirmed once the server has created the record.'}
        </Muted>
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({
  label, value, onChangeText, placeholder, error, hint, keyboardType, multiline,
}: {
  label: string; value: string; onChangeText: (s: string) => void; placeholder?: string;
  error?: string | null; hint?: string; keyboardType?: 'decimal-pad'; multiline?: boolean;
}) {
  const p = usePalette();
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: p.textMuted, marginBottom: 6 }}>
        {label.toUpperCase()}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={p.textMuted}
        keyboardType={keyboardType}
        multiline={multiline}
        accessibilityLabel={label}
        style={{
          borderWidth: 1, borderColor: error ? p.danger : p.border, backgroundColor: p.bg,
          borderRadius: 8, paddingHorizontal: 11, paddingVertical: 10, color: p.text, fontSize: 15,
          minHeight: multiline ? 66 : undefined, textAlignVertical: multiline ? 'top' : 'center',
        }}
      />
      {error ? <Text style={{ color: p.danger, fontSize: 12, marginTop: 5 }}>{error}</Text> : null}
      {hint && !error ? <Text style={{ color: p.textMuted, fontSize: 12, marginTop: 5 }}>{hint}</Text> : null}
    </View>
  );
}
