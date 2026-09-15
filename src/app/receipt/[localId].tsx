import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Image, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatDateOnlyHuman } from '@/domain/dates';
import { findMatchCandidates } from '@/domain/matching';
import { formatMinorUnits } from '@/domain/money';
import { useApp } from '@/ui/app-context';
import { Badge, Banner, Button, Card, Muted, Row, SectionTitle, Title } from '@/ui/components';
import { describeCompanyBlock, describeStatus } from '@/ui/receipt-status';
import { usePalette } from '@/ui/theme';

export default function ReceiptDetailScreen() {
  const { localId } = useLocalSearchParams<{ localId: string }>();
  const router = useRouter();
  const p = usePalette();
  const { drafts, transactions, companies, session, actions, syncing } = useApp();
  const [working, setWorking] = useState(false);

  const draft = drafts.find((d) => d.localId === localId);

  const candidates = useMemo(
    () => (draft ? findMatchCandidates(draft, transactions, { limit: 5 }) : []),
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
        // Worth saying out loud: this is the lost-response case resolving safely.
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

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={['bottom']}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
        {draft.fileUri ? (
          <Image
            source={{ uri: draft.fileUri }}
            style={{ width: '100%', height: 220, borderRadius: 12, backgroundColor: p.surfaceAlt }}
            resizeMode="contain"
            accessibilityLabel="Receipt image"
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
        </Card>

        <Card>
          <SectionTitle>Status</SectionTitle>
          <Row gap={12} style={{ alignItems: 'flex-start' }}>
            <Badge caption="On this device" label={status.deviceLabel} tone={status.deviceTone} />
            <Badge caption="On the server" label={status.serverLabel} tone={status.serverTone} />
          </Row>
          <View style={{ height: 10 }} />
          <Muted>{status.explanation}</Muted>

          <View style={{ height: 10 }} />
          <Text style={{ color: p.textMuted, fontSize: 12, fontFamily: 'monospace' }}>
            server id: {draft.serverReceiptId ?? '—'}
          </Text>
          <Text style={{ color: p.textMuted, fontSize: 12, fontFamily: 'monospace' }}>
            idempotency: {draft.idempotencyKey.slice(0, 18)}…
          </Text>
          <Text style={{ color: p.textMuted, fontSize: 12, fontFamily: 'monospace' }}>
            attempts: {draft.attemptCount} · company: {companyName(draft.companyId)}
          </Text>
        </Card>

        {blocked ? <Banner tone="warning">{blocked}</Banner> : null}

        {draft.serverReceiptId === null ? (
          <Card>
            <SectionTitle>Match to a transaction</SectionTitle>
            <Muted>
              Matching is sent with the submission. The server is the one that saves it, and it will
              refuse a transaction that already belongs to another receipt.
            </Muted>
            <View style={{ height: 10 }} />
            {candidates.length === 0 ? (
              <Muted>No comparable transactions for this company.</Muted>
            ) : (
              candidates.map((c) => {
                const selected = draft.pendingMatchTransactionId === c.transaction.id;
                return (
                  <View
                    key={c.transaction.id}
                    style={{
                      borderWidth: 1, borderRadius: 9, padding: 11, marginBottom: 8,
                      borderColor: selected ? p.accent : p.border,
                      backgroundColor: selected ? p.surfaceAlt : 'transparent',
                      opacity: c.blocked ? 0.55 : 1,
                    }}
                  >
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={{ color: p.text, fontWeight: '700', fontSize: 14, flex: 1 }}>
                        {c.transaction.merchant}
                      </Text>
                      <Text style={{ color: p.textMuted, fontSize: 12 }}>{c.score}%</Text>
                    </Row>
                    <Muted>
                      {c.transaction.currency}{' '}
                      {formatMinorUnits(c.transaction.amountMinorUnits, c.transaction.currency)} ·{' '}
                      {c.transaction.occurredAt.slice(0, 10)}
                    </Muted>
                    {c.isExact ? <Text style={{ color: p.success, fontSize: 12, marginTop: 4 }}>Exact match</Text> : null}
                    {c.blocked ? (
                      <Text style={{ color: p.warning, fontSize: 12, marginTop: 4 }}>{c.blockedReason}</Text>
                    ) : (
                      <View style={{ marginTop: 8 }}>
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
          <Banner tone="danger">
            This will not succeed by retrying. {draft.lastError}
          </Banner>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
