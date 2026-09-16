import { Link, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { formatMinorUnits } from '@/domain/money';
import { formatDateOnlyHuman } from '@/domain/dates';
import type { ReceiptDraft } from '@/domain/types';
import { useApp } from '@/ui/app-context';
import { Badge, Banner, Button, Card, Muted, Row, SectionTitle, Title } from '@/ui/components';
import { describeStatus } from '@/ui/receipt-status';
import { usePalette } from '@/ui/theme';

function ReceiptRow({ draft, onPress }: { draft: ReceiptDraft; onPress: () => void }) {
  const p = usePalette();
  const status = describeStatus(draft);

  return (
    <Card style={{ marginBottom: 10 }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }} accessible accessibilityRole="header">
          <Title>{draft.vendor ?? 'Untitled receipt'}</Title>
          <Muted>
            {draft.amountMinorUnits !== null && draft.currency
              ? `${draft.currency} ${formatMinorUnits(draft.amountMinorUnits, draft.currency)}`
              : 'No amount yet'}
            {draft.transactionDate ? ` · ${formatDateOnlyHuman(draft.transactionDate)}` : ''}
          </Muted>
        </View>
      </Row>

      {/*
        The two-column status. This is the brief's "local and remote state are
        visibly different" made literal: the user always sees both, and the
        right-hand column says "Not received" until the server proves otherwise.
      */}
      <View
        accessible
        accessibilityRole="summary"
        accessibilityLabel={`On this device: ${status.deviceLabel}. On the server: ${status.serverLabel}. ${status.explanation}`}
      >
        <Row style={{ marginTop: 12, alignItems: 'flex-start' }} gap={12}>
          <Badge caption="On this device" label={status.deviceLabel} tone={status.deviceTone} />
          <Badge caption="On the server" label={status.serverLabel} tone={status.serverTone} />
        </Row>

        <Text style={{ color: p.textMuted, fontSize: 12, lineHeight: 18, marginTop: 10 }}>
          {status.explanation}
        </Text>
      </View>

      <View style={{ marginTop: 12 }}>
        <Button
          title="Open"
          variant="secondary"
          onPress={onPress}
          accessibilityLabel={`Open receipt from ${draft.vendor ?? 'unnamed vendor'}`}
        />
      </View>
    </Card>
  );
}

export default function ReceiptListScreen() {
  const router = useRouter();
  const p = usePalette();
  const { ready, bootError, ephemeralStorage, session, company, companies, drafts, networkMode, syncing, actions } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const report = await actions.syncNow();
    if (report) {
      setLastSync(
        `Sync: ${report.advanced} advanced, ${report.failed} failed, ${report.skipped} skipped.`,
      );
    }
    setRefreshing(false);
  }, [actions]);

  if (!ready) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: p.bg, alignItems: 'center', justifyContent: 'center' }}>
        <Muted>Opening local database…</Muted>
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: p.bg, padding: 16, gap: 12 }}>
        <Title>Choose a company to sign in</Title>
        <Muted>
          Two companies are seeded. Receipts captured under one are never visible or submittable
          under the other — that boundary is the point of the exercise, so it is easy to test here.
        </Muted>
        {companies.map((c) => (
          <Button key={c.id} title={c.name} onPress={() => void actions.signIn(c.id)} />
        ))}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={['bottom', 'left', 'right']}>
      <FlatList
        data={drafts}
        keyExtractor={(d) => d.localId}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
        ListHeaderComponent={
          <View style={{ gap: 10, marginBottom: 14 }}>
            {ephemeralStorage ? (
              <Banner tone="warning">
                Running without native storage (web preview). Drafts are held in memory only and will
                not survive a reload. On a device they are written to SQLite.
              </Banner>
            ) : null}
            {bootError && !ephemeralStorage ? <Banner tone="danger">{bootError}</Banner> : null}

            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <SectionTitle>Signed in</SectionTitle>
                <Title>{company?.name ?? session.companyId}</Title>
              </View>
              <Link href="/settings" style={{ color: p.accent, fontWeight: '700', fontSize: 14 }}>
                Settings
              </Link>
            </Row>

            <Banner tone={networkMode === 'online' ? 'neutral' : 'pending'}>
              {networkMode === 'online'
                ? 'Online — submissions go straight to the server.'
                : 'Offline — submissions are queued durably on this device and sent later.'}
            </Banner>

            {lastSync ? <Muted>{lastSync}</Muted> : null}

            <Row gap={10}>
              <View style={{ flex: 1 }}>
                <Button title="Capture receipt" onPress={() => router.push('/capture')} />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  title={syncing ? 'Syncing…' : 'Sync now'}
                  variant="secondary"
                  disabled={syncing}
                  onPress={() => void onRefresh()}
                />
              </View>
            </Row>
          </View>
        }
        ListEmptyComponent={
          <Card>
            <Title>No receipts yet</Title>
            <View style={{ height: 6 }} />
            <Muted>
              Capture one to see the draft → queued → uploading → confirmed flow. Try switching to
              offline in Settings first to watch the queue behave.
            </Muted>
          </Card>
        }
        renderItem={({ item }) => (
          <ReceiptRow draft={item} onPress={() => router.push(`/receipt/${item.localId}`)} />
        )}
      />
    </SafeAreaView>
  );
}
