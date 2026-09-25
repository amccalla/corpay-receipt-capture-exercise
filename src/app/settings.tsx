import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useApp } from '@/ui/app-context';
import { Banner, Button, Card, Muted, NetworkPill, Row, SectionTitle, Title } from '@/ui/components';
import { usePalette } from '@/ui/theme';
import type { FailureInjection } from '@/server/fake-server';

/**
 * The simulation console.
 *
 * Every failure the app claims to survive is triggerable from here. A failure
 * path you cannot demonstrate on demand is a failure path nobody has tested,
 * so these controls are part of the deliverable rather than debug scaffolding.
 */
const FAILURES: { key: FailureInjection; label: string; blurb: string }[] = [
  { key: 'none', label: 'No failure', blurb: 'Requests succeed normally.' },
  {
    key: 'lostSuccessResponse',
    label: 'Lost success response',
    blurb:
      'The server creates the record but the reply never arrives. Retrying must return the original record, not make a second one.',
  },
  {
    key: 'authExpired',
    label: 'Auth expired mid-upload',
    blurb: 'The token lapses while the transfer is running. The receipt stays queued, not lost.',
  },
  {
    key: 'transferInterrupted',
    label: 'Transfer interrupted',
    blurb: 'The connection drops before the server accepts the file. Retryable.',
  },
  {
    key: 'fileTooLarge',
    label: 'File too large',
    blurb: 'The server rejects the upload permanently. Retrying is pointless and the app says so.',
  },
  {
    key: 'unsupportedType',
    label: 'Unsupported type (HEIC)',
    blurb: 'The server will not take this format. Permanent, with an actionable message.',
  },
  {
    key: 'uncertainReading',
    label: 'Uncertain reading',
    blurb:
      'The receipt is accepted and recorded, but read too poorly to confirm. It lands in Needs review, where your own corrections still win over anything read later.',
  },
  { key: 'serverError', label: 'Server error', blurb: 'A 500. Retryable.' },
];

export default function SettingsScreen() {
  const p = usePalette();
  const router = useRouter();
  const { session, user, company, companies, networkMode, failureInjection, drafts, actions } = useApp();

  // Only companies this user actually belongs to. Offering a company the server
  // would refuse is the "hidden client button" mistake in reverse: a control
  // that exists purely to fail.
  const myCompanies = useMemo(
    () => (session ? companies.filter((c) => actions.isMember(session.userId, c.id)) : []),
    [companies, session, actions],
  );
  const canSwitch = myCompanies.length > 1;

  // Signing out must leave this screen: the session is gone, so every control
  // here refers to something that no longer exists.
  const signOut = useCallback(async () => {
    await actions.signOut();
    router.dismissAll();
    router.replace('/');
  }, [actions, router]);

  const pendingElsewhere = drafts.filter((d) => d.state === 'queued' || d.state === 'failed').length;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={['bottom']}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
        <Card>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <SectionTitle>Connectivity</SectionTitle>
            <NetworkPill online={networkMode === 'online'} />
          </Row>
          <Muted>
            Offline submissions are written to the device and never reported as confirmed. This is the
            switch to prove that with.
          </Muted>
          <Row gap={10} style={{ marginTop: 12 }}>
            <View style={{ flex: 1 }}>
              <Button
                title="Online"
                selected={networkMode === 'online'}
                variant={networkMode === 'online' ? 'primary' : 'secondary'}
                onPress={() => actions.setNetworkMode('online')}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="Offline"
                selected={networkMode === 'offline'}
                variant={networkMode === 'offline' ? 'primary' : 'secondary'}
                onPress={() => actions.setNetworkMode('offline')}
              />
            </View>
          </Row>
        </Card>

        <Card>
          <SectionTitle>Company</SectionTitle>
          <Title>{company?.name ?? 'Signed out'}</Title>
          <View style={{ height: 6 }} />
          {canSwitch ? (
            <Muted>
              Switching company destroys the current token before issuing a new one. Anything queued
              under the previous company stays with that company and cannot be submitted from here.
            </Muted>
          ) : null}
          {canSwitch && pendingElsewhere > 0 ? (
            <View style={{ marginTop: 10 }}>
              <Banner tone="pending">
                {pendingElsewhere} receipt{pendingElsewhere === 1 ? '' : 's'} still waiting to be sent
                under {company?.name}. They stay with this company if you switch.
              </Banner>
            </View>
          ) : null}
          {canSwitch ? (
            <View style={{ gap: 8, marginTop: 12 }}>
              {myCompanies.map((c) => (
                <Button
                  key={c.id}
                  title={c.id === session?.companyId ? `${c.name} (current)` : `Switch to ${c.name}`}
                  selected={c.id === session?.companyId}
                  variant={c.id === session?.companyId ? 'primary' : 'secondary'}
                  onPress={() => void actions.switchCompany(c.id)}
                />
              ))}
            </View>
          ) : (
            <View style={{ marginTop: 10 }}>
              <Muted>
                {user?.displayName ?? 'This user'} belongs to one company, so there is nothing to
                switch to. Sign out to act as someone else.
              </Muted>
            </View>
          )}
        </Card>

        <Card>
          <SectionTitle>Session</SectionTitle>
          <View
            accessible
            accessibilityLabel={`Signed in as ${session?.userId ?? 'nobody'}. Session expires at ${session?.expiresAt?.slice(11, 19) ?? 'unknown'}.`}
          >
            <Text style={{ color: p.textMuted, fontSize: 12, fontFamily: 'monospace' }}>
              user: {session?.userId ?? '—'}
            </Text>
            <Text style={{ color: p.textMuted, fontSize: 12, fontFamily: 'monospace' }}>
              expires: {session?.expiresAt?.slice(11, 19) ?? '—'}
            </Text>
          </View>
          <View style={{ height: 6 }} />
          <Muted>
            The token lives in the device keychain, never in the database or ordinary app storage.
          </Muted>
          <View style={{ gap: 8, marginTop: 12 }}>
            <Button title="Expire my token now" variant="secondary" onPress={() => actions.expireSession()} />
            <Button title="Sign out" variant="danger" onPress={() => void signOut()} />
          </View>
        </Card>

        <Card>
          <SectionTitle>Inject a failure</SectionTitle>
          <Muted>Applies to the next submission.</Muted>
          <View style={{ gap: 8, marginTop: 12 }}>
            {FAILURES.map((f) => (
              <View key={f.key}>
                <Button
                  title={f.label}
                  selected={failureInjection === f.key}
                  // The blurb is only rendered for the selected option, so it
                  // is folded into the label here - otherwise a screen reader
                  // user choosing between seven failures hears seven bare names
                  // and no explanation of any of them.
                  accessibilityLabel={`${f.label}. ${f.blurb}`}
                  variant={failureInjection === f.key ? 'primary' : 'secondary'}
                  onPress={() => actions.setFailureInjection(f.key)}
                />
                {failureInjection === f.key ? (
                  <Text style={{ color: p.textMuted, fontSize: 12, lineHeight: 18, marginTop: 6 }}>
                    {f.blurb}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}
