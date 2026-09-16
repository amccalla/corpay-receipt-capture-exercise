import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Image, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isAmbiguous, rankAndExplain, type ConfidenceBand } from '@/domain/confidence';
import { formatDateOnlyHuman } from '@/domain/dates';
import { findMatchCandidates } from '@/domain/matching';
import { formatMinorUnits } from '@/domain/money';
import { useApp } from '@/ui/app-context';
import { Badge, Banner, Button, Card, Muted, Row, SectionTitle, Title } from '@/ui/components';
import { describeCompanyBlock, describeStatus, type Tone } from '@/ui/receipt-status';
import { usePalette } from '@/ui/theme';

/** Confidence bands map onto the same tone vocabulary the status badges use. */
const BAND_TONE: Record<ConfidenceBand, Tone> = {
  exact: 'success',
  high: 'success',
  medium: 'pending',
  low: 'warning',
  none: 'neutral',
};

const BAND_LABEL: Record<ConfidenceBand, string> = {
  exact: 'Exact match',
  high: 'Likely match',
  medium: 'Possible match',
  low: 'Weak match',
  none: 'Not comparable',
};

export default function ReceiptDetailScreen() {
  const { localId } = useLocalSearchParams<{ localId: string }>();
  const router = useRouter();
  const p = usePalette();
  const { drafts, transactions, companies, session, actions, syncing } = useApp();
  const [working, setWorking] = useState(false);

  const draft = drafts.find((d) => d.localId === localId);

  const ranked = useMemo(
    () => (draft ? rankAndExplain(draft, findMatchCandidates(draft, transactions, { limit: 5 })) : []),
    [draft, transactions],
  );
  const ambiguous = useMemo(
    () => (draft ? isAmbiguous(findMatchCandidates(draft, transactions, { limit: 5 })) : false),
    [draft, transactions],
  );

  const companyName = useCallback(
    (id: string) => companies.find((c) => c.id === id)?.name ?? id,
    [companies],
  );

  const submit = useCallback(async () => {
    if (!draft) return;
    setWorking(true);
    try {
      const outcome = await actions.submitDraft(draft.localId);
      if (outcome?.kind === 'failed') {
        Alert.alert('Not accepted', outcome.draft.lastError ?? 'The server rejected this receipt.');
      } else if (outcome?.kind === 'advanced' && outcome.deduped) {
        Alert.alert(
          'Already on the server',
          'The server had already recorded this receipt from an earlier attempt, so nothing was duplicated.',
        );
      }
    } finally {
      setWorking(false);
    }
  }, [draft, actions]);

  if (!draft) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: p.bg, padding: 16 }}>
        <Card>
          <Title>Not available here</Title>
          <View style={{ height: 6 }} />
          <Muted>
            This receipt is not visible under the company you are signed in to. Receipts are scoped to
            the company they were captured under.
          </Muted>
          <View style={{ height: 12 }} />
          <Button title="Back to receipts" variant="secondary" onPress={() => router.back()} />
        </Card>
      </SafeAreaView>
    );
  }

  const status = describeStatus(draft);
  const blocked = describeCompanyBlock(draft, session?.companyId ?? null, companyName);
  const busy = working || syncing;
  const editable = draft.serverReceiptId === null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={['bottom']}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
        {draft.fileUri ? (
          <Image
            source={{ uri: draft.fileUri }}
            style={{ width: '100%', height: 220, borderRadius: 12, backgroundColor: p.surfaceAlt }}
            resizeMode="contain"
            accessible
            accessibilityRole="image"
            accessibilityLabel={`Receipt image for ${draft.vendor ?? 'this receipt'}`}
          />
        ) : null}

        <Card>
          <Title>{draft.vendor ?? 'Untitled receipt'}</Title>
          <View style={{ height: 4 }} />
          <Muted>
            {draft.amountMinorUnits !== null && draft.currency
              ? `${draft.currency} ${formatMinorUnits(draft.amountMinorUnits, draft.currency)}`
              : 'No amount'}
            {draft.transactionDate ? ` · ${formatDateOnlyHuman(draft.transactionDate)}` : ''}
          </Muted>
          {draft.notes ? (
            <>
              <View style={{ height: 8 }} />
              <Muted>{draft.notes}</Muted>
            </>
          ) : null}

          {editable ? (
            <View style={{ marginTop: 12 }}>
              <Button
                title="Scan barcode or QR"
                variant="secondary"
                onPress={() => router.push(`/scan?localId=${draft.localId}`)}
              />
            </View>
          ) : null}
        </Card>

        {/*
          The status pair is grouped for assistive tech. Read separately, "Queued"
          and "Not received" are two disconnected words; the group reads as one
          sentence that actually conveys the local/remote distinction the whole
          app is built around.
        */}
        <Card>
          <SectionTitle>Status</SectionTitle>
          <View
            accessible
            accessibilityRole="summary"
            accessibilityLabel={`On this device: ${status.deviceLabel}. On the server: ${status.serverLabel}. ${status.explanation}`}
          >
            <Row gap={12} style={{ alignItems: 'flex-start' }}>
              <Badge caption="On this device" label={status.deviceLabel} tone={status.deviceTone} />
              <Badge caption="On the server" label={status.serverLabel} tone={status.serverTone} />
            </Row>
            <View style={{ height: 10 }} />
            <Muted>{status.explanation}</Muted>
          </View>

          <View style={{ height: 10 }} accessible={false} />
          <View accessible accessibilityLabel={`Technical details. Server id ${draft.serverReceiptId ?? 'none'}. Attempt ${draft.attemptCount}. Company ${companyName(draft.companyId)}.`}>
            <Text style={{ color: p.textMuted, fontSize: 12, fontFamily: 'monospace' }}>
              server id: {draft.serverReceiptId ?? '—'}
            </Text>
            <Text style={{ color: p.textMuted, fontSize: 12, fontFamily: 'monospace' }}>
              idempotency: {draft.idempotencyKey.slice(0, 18)}…
            </Text>
            <Text style={{ color: p.textMuted, fontSize: 12, fontFamily: 'monospace' }}>
              attempts: {draft.attemptCount} · company: {companyName(draft.companyId)}
            </Text>
          </View>
        </Card>

        {blocked ? <Banner tone="warning">{blocked}</Banner> : null}

        {editable ? (
          <Card>
            <SectionTitle>Match to a transaction</SectionTitle>
            <Muted>
              Matching is sent with the submission. The server saves it, and will refuse a transaction
              that already belongs to another receipt.
            </Muted>

            {ambiguous ? (
              <View style={{ marginTop: 10 }}>
                <Banner tone="pending">
                  Two transactions look equally likely. Nothing has been pre-selected — pick the right
                  one yourself.
                </Banner>
              </View>
            ) : null}

            <View style={{ height: 10 }} />
            {ranked.length === 0 ? (
              <Muted>No comparable transactions for this company.</Muted>
            ) : (
              ranked.map((c) => {
                const selected = draft.pendingMatchTransactionId === c.transaction.id;
                const v = c.verdict;
                const amount = `${c.transaction.currency} ${formatMinorUnits(c.transaction.amountMinorUnits, c.transaction.currency)}`;
                return (
                  <View
                    key={c.transaction.id}
                    accessible
                    accessibilityRole="radio"
                    accessibilityState={{ selected, disabled: c.blocked || busy }}
                    accessibilityLabel={`${c.transaction.merchant}, ${amount}, ${c.transaction.occurredAt.slice(0, 10)}. ${BAND_LABEL[v.band]}. ${v.summary}`}
                    accessibilityHint={c.blocked ? undefined : selected ? 'Double tap to deselect' : 'Double tap to select this transaction'}
                    style={{
                      borderWidth: selected ? 2 : 1,
                      borderRadius: 9,
                      padding: 11,
                      marginBottom: 8,
                      borderColor: selected ? p.accent : p.border,
                      backgroundColor: selected ? p.surfaceAlt : 'transparent',
                      opacity: c.blocked ? 0.6 : 1,
                    }}
                  >
                    <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <Text style={{ color: p.text, fontWeight: '700', fontSize: 14, flex: 1 }}>
                        {c.transaction.merchant}
                      </Text>
                      <Badge label={BAND_LABEL[v.band]} tone={BAND_TONE[v.band]} />
                    </Row>
                    <Muted>
                      {amount} · {c.transaction.occurredAt.slice(0, 10)}
                    </Muted>

                    <Text style={{ color: p.text, fontSize: 13, lineHeight: 19, marginTop: 8 }}>
                      {v.summary}
                    </Text>

                    {v.reasons.length > 0 ? (
                      <View style={{ marginTop: 6 }}>
                        {v.reasons.map((r) => (
                          <Text key={r} style={{ color: p.success, fontSize: 12, lineHeight: 18 }}>
                            ✓ {r}
                          </Text>
                        ))}
                      </View>
                    ) : null}

                    {/* The honest other half. A confidence UI that only lists
                        supporting evidence is a persuasion UI. */}
                    {v.caveats.length > 0 ? (
                      <View style={{ marginTop: 4 }}>
                        {v.caveats.map((r) => (
                          <Text key={r} style={{ color: p.warning, fontSize: 12, lineHeight: 18 }}>
                            • {r}
                          </Text>
                        ))}
                      </View>
                    ) : null}

                    {c.blocked ? (
                      <Text style={{ color: p.warning, fontSize: 12, marginTop: 8, fontWeight: '600' }}>
                        {c.blockedReason}
                      </Text>
                    ) : (
                      <View style={{ marginTop: 10 }}>
                        <Button
                          title={selected ? 'Selected' : 'Select'}
                          variant={selected ? 'primary' : 'secondary'}
                          disabled={busy}
                          onPress={() =>
                            void actions.patchDraft(draft.localId, {
                              pendingMatchTransactionId: selected ? null : c.transaction.id,
                            })
                          }
                        />
                      </View>
                    )}

                    {v.requiresReview && selected ? (
                      <View style={{ marginTop: 8 }}>
                        <Muted>
                          This match is weak enough that it will be flagged for review after you submit.
                        </Muted>
                      </View>
                    ) : null}
                  </View>
                );
              })
            )}
          </Card>
        ) : draft.matchedTransactionId ? (
          <Card>
            <SectionTitle>Matched</SectionTitle>
            <Muted>
              The server saved a match to{' '}
              {transactions.find((t) => t.id === draft.matchedTransactionId)?.merchant ??
                draft.matchedTransactionId}
              .
            </Muted>
          </Card>
        ) : null}

        {!blocked && status.action ? (
          <Button
            title={busy ? 'Working…' : (status.actionLabel ?? 'Submit')}
            disabled={busy || !draft.fileUri}
            onPress={() => void submit()}
          />
        ) : null}

        {draft.state === 'failed' && !draft.lastErrorRetryable ? (
          <Banner tone="danger">This will not succeed by retrying. {draft.lastError}</Banner>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
