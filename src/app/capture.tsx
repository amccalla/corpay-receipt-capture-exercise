import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isValidDateOnly } from '@/domain/dates';
import { provenanceForForm } from '@/domain/extraction';
import { safeStorageKey } from '@/domain/validation';
import { extractFromReceipt, type OcrResult } from '@/server/ocr';
import { formatMinorUnits, parseAmountToMinorUnits } from '@/domain/money';
import type { ReceiptDraft } from '@/domain/types';
import { useApp } from '@/ui/app-context';
import { Banner, Button, Card, Muted, Row, SectionTitle } from '@/ui/components';
import { CurrencyPicker } from '@/ui/currency-picker';
import { intakeFile } from '@/ui/file-intake';
import { usePalette } from '@/ui/theme';

/** Example input per currency, for the amount field's hint. */
const SYMBOL_HINTS: Readonly<Record<string, string>> = {
  USD: '$19.99', EUR: '\u20ac19.99', GBP: '\u00a310.50',
  JPY: '\u00a5500', INR: '\u20b9250', KRW: '\u20a95000',
};

export default function CaptureScreen() {
  const router = useRouter();
  const p = usePalette();
  const { actions, networkMode, session } = useApp();

  const [draft, setDraft] = useState<ReceiptDraft | null>(null);
  const [vendor, setVendor] = useState('');
  const [amountText, setAmountText] = useState('');
  const [currency, setCurrency] = useState('USD');
  // Accepting the default is not the same event as choosing a currency, and
  // recording them identically would lock an unconsidered 'USD' in as a human
  // decision that no later barcode or OCR pass could correct.
  const [currencyChosen, setCurrencyChosen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Which fields the person edited themselves, and which a read pre-filled.
  // Kept apart because they mean different things on save - see
  // provenanceForForm.
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [prefilled, setPrefilled] = useState<Set<string>>(new Set());
  const [proposal, setProposal] = useState<OcrResult | null>(null);

  const markEdited = useCallback((field: string) => {
    setEdited((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
  }, []);
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

  /**
   * Produce the simulated reading for this draft.
   *
   * This build has NO OCR. `extractFromReceipt` takes a storage key string and
   * never sees the image, so the values are generated from the draft's id, not
   * read from the photo. An earlier version wrote them straight into the form
   * under a banner saying they had been "read from the image" — which was
   * false, and left the user deleting invented data off a real receipt.
   *
   * So it is offered as a clearly-labelled proposal the person accepts or
   * ignores. The machinery it exists to demonstrate — provenance, correction,
   * and a later pass being unable to overwrite a human — is unchanged.
   */
  const proposeReading = useCallback(
    (localId: string, mime: string) => {
      const companyId = session?.companyId;
      if (!companyId) return;
      setProposal(extractFromReceipt(safeStorageKey(companyId, localId, mime)));
    },
    [session?.companyId],
  );

  /** Accept the simulated values, for fields the person has not typed into. */
  const acceptProposal = useCallback(() => {
    if (!proposal) return;
    const next = new Set(prefilled);

    if (proposal.vendor && !edited.has('vendor')) {
      setVendor(proposal.vendor);
      next.add('vendor');
    }
    if (proposal.currency && !edited.has('currency')) {
      setCurrency(proposal.currency);
      next.add('currency');
    }
    if (proposal.amountMinorUnits !== null && proposal.currency && !edited.has('amount')) {
      setAmountText(formatMinorUnits(proposal.amountMinorUnits, proposal.currency));
      next.add('amount');
    }
    if (proposal.transactionDate && !edited.has('transactionDate')) {
      setDateText(proposal.transactionDate);
      next.add('transactionDate');
    }

    setPrefilled(next);
    setProposal(null);
  }, [proposal, prefilled, edited]);

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

        // Read the receipt as soon as we have it. Keyed on the SAME storage key
        // the server will use, so the client's pre-fill and the server's later
        // pass agree by construction rather than by luck.
        proposeReading(d.localId, intake.mimeType);
      } catch (err) {
        setFileError(err instanceof Error ? err.message : 'Could not read that file.');
      } finally {
        setBusy(false);
      }
    },
    [actions, ensureDraft, proposeReading],
  );

  // Shown as a hint so the symbol affordance is discoverable. A symbol is only
  // accepted when it matches the selected currency - see money.ts.
  const currencyHint = SYMBOL_HINTS[currency] ?? `${currency} 19.99`;

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
          // Typed and pre-filled are recorded differently. See provenanceForForm:
          // a blanket 'user' stamp would lock an unread guess, and an untouched
          // currency default, against any later correction.
          provenance: provenanceForForm({
            vendor: {
              hasValue: vendor.trim() !== '',
              editedByUser: edited.has('vendor'),
              filledByOcr: prefilled.has('vendor'),
            },
            amount: {
              hasValue: true,
              editedByUser: edited.has('amount'),
              filledByOcr: prefilled.has('amount'),
            },
            currency: {
              hasValue: true,
              editedByUser: currencyChosen,
              filledByOcr: prefilled.has('currency'),
            },
            transactionDate: {
              hasValue: dateText.trim() !== '',
              editedByUser: edited.has('transactionDate'),
              filledByOcr: prefilled.has('transactionDate'),
            },
          }),
        });

        if (submit) {
          const outcome = await actions.submitDraft(d.localId);
          if (outcome?.kind === 'failed') {
            Alert.alert('Not accepted', outcome.draft.lastError ?? 'This receipt was rejected.');
          }
        }
        router.back();
      } finally {
        setBusy(false);
      }
    },
    [draft, amountParse, vendor, currency, currencyChosen, dateText, notes, edited, prefilled, actions, router],
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

          {proposal && !fileError ? (
            <View
              style={{
                marginTop: 12, borderWidth: 1, borderColor: p.border,
                borderRadius: 9, padding: 13, backgroundColor: p.bg,
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: p.warning }}>
                SIMULATED EXTRACTION
              </Text>
              <View style={{ height: 6 }} />
              <Muted>
                This build has no OCR. These values are generated from the receipt&apos;s id — they are
                not read from your photo, and they will not match what it says. They exist so the
                review-and-correct flow can be demonstrated.
              </Muted>
              <View style={{ height: 10 }} />
              <ReadRow label="Vendor" value={proposal.vendor} />
              <ReadRow
                label="Amount"
                value={
                  proposal.amountMinorUnits !== null && proposal.currency
                    ? `${proposal.currency} ${formatMinorUnits(proposal.amountMinorUnits, proposal.currency)}`
                    : null
                }
              />
              <ReadRow label="Date" value={proposal.transactionDate} />
              <View style={{ height: 12 }} />
              <Row gap={10}>
                <View style={{ flex: 1 }}>
                  <Button title="Ignore" variant="secondary" onPress={() => setProposal(null)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button title="Use these" onPress={acceptProposal} />
                </View>
              </Row>
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
          <Field
            label="Vendor"
            value={vendor}
            onChangeText={(v) => { setVendor(v); markEdited('vendor'); }}
            placeholder="Blue Bottle Coffee"
          />

          <Row gap={10} style={{ alignItems: 'flex-start' }}>
            <View style={{ flex: 2 }}>
              <Field
                label="Amount"
                value={amountText}
                onChangeText={(v) => { setAmountText(v); markEdited('amount'); }}
                placeholder="19.99"
                keyboardType="decimal-pad"
                error={amountError}
                hint={`A ${currency} symbol or code is accepted, e.g. ${currencyHint}`}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: p.textMuted, marginBottom: 6, marginTop: 4 }}>
                CURRENCY
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Currency: ${currency}. Double tap to change.`}
                onPress={() => setPickerOpen(true)}
                style={{
                  borderWidth: 1, borderColor: p.border, backgroundColor: p.bg,
                  borderRadius: 8, paddingHorizontal: 11, paddingVertical: 11,
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                }}
              >
                <Text style={{ color: p.text, fontSize: 15, fontWeight: '700' }}>{currency}</Text>
                <Text style={{ color: p.textMuted, fontSize: 13 }}>▾</Text>
              </Pressable>
            </View>
          </Row>

          <Field
            label="Transaction date"
            value={dateText}
            onChangeText={(v) => { setDateText(v); markEdited('transactionDate'); }}
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
            ? 'Offline. This is saved on the device and stays queued until you are online again. It will not read as confirmed until the backend has actually recorded it.'
            : 'This is submitted now. It only reads as confirmed once the backend has created the record.'}
        </Muted>
      </ScrollView>

      <CurrencyPicker
        visible={pickerOpen}
        value={currency}
        onClose={() => setPickerOpen(false)}
        onSelect={(c) => {
          setCurrency(c);
          setCurrencyChosen(true);
        }}
      />
    </SafeAreaView>
  );
}

function ReadRow({ label, value }: { label: string; value: string | null }) {
  const p = usePalette();
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 3 }}>
      <Text style={{ color: p.textMuted, fontSize: 13 }}>{label}</Text>
      <Text style={{ color: value ? p.text : p.textMuted, fontSize: 14, fontWeight: value ? '600' : '400' }}>
        {value ?? 'not produced'}
      </Text>
    </Row>
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
