import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { exponentFor } from '@/domain/money';
import { COMMON_CURRENCIES, filterCurrencies, type CurrencyOption } from './currencies';
import { Row } from './components';
import { usePalette } from './theme';

/**
 * Currency picker over all 59 currencies the parser supports.
 *
 * A picker rather than a handful of buttons because the decimal rules are the
 * whole point: JPY has no minor unit and BHD has three, and a user who cannot
 * reach those currencies can never hit the paths that make that matter.
 * Selecting here is also what marks the field as a human decision — see
 * `provenanceForUserEntry`.
 */
export function CurrencyPicker({
  value,
  onSelect,
  onClose,
  visible,
}: {
  value: string;
  onSelect: (code: string) => void;
  onClose: () => void;
  visible: boolean;
}) {
  const p = usePalette();
  const [query, setQuery] = useState('');

  const { common, rest } = useMemo(() => {
    const matches = filterCurrencies(query);
    const commonSet = new Set(COMMON_CURRENCIES);
    return {
      common: query.trim() === '' ? matches.filter((c) => commonSet.has(c.code)) : [],
      rest: query.trim() === '' ? matches.filter((c) => !commonSet.has(c.code)) : matches,
    };
  }, [query]);

  const renderRow = (c: CurrencyOption) => {
    const selected = c.code === value;
    const exp = exponentFor(c.code);
    return (
      <Pressable
        key={c.code}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        accessibilityLabel={`${c.name}, ${c.code}, ${exp} decimal places`}
        onPress={() => {
          onSelect(c.code);
          onClose();
        }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingVertical: 13,
          paddingHorizontal: 16,
          backgroundColor: selected ? p.surfaceAlt : pressed ? p.surfaceAlt : 'transparent',
        })}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ color: p.text, fontSize: 15, fontWeight: selected ? '700' : '500' }}>
            {c.code} · {c.name}
          </Text>
          {/* Surfacing the exponent is not decoration: it explains why the
              amount field will reject "500.00" for JPY. */}
          <Text style={{ color: p.textMuted, fontSize: 12, marginTop: 2 }}>
            {exp === 0 ? 'no decimal places' : `${exp} decimal places`}
          </Text>
        </View>
        {selected ? <Text style={{ color: p.accent, fontWeight: '800', fontSize: 16 }}>✓</Text> : null}
      </Pressable>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }}>
        <View style={{ padding: 16, gap: 10 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ color: p.text, fontSize: 18, fontWeight: '700' }}>Currency</Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close currency picker">
              <Text style={{ color: p.accent, fontWeight: '700', fontSize: 15 }}>Done</Text>
            </Pressable>
          </Row>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search code or name"
            placeholderTextColor={p.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            accessibilityLabel="Search currencies"
            style={{
              borderWidth: 1, borderColor: p.border, backgroundColor: p.surface,
              borderRadius: 8, paddingHorizontal: 11, paddingVertical: 10, color: p.text, fontSize: 15,
            }}
          />
        </View>

        <FlatList
          data={rest}
          keyExtractor={(c) => c.code}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            common.length > 0 ? (
              <View>
                <SectionLabel>Common</SectionLabel>
                {common.map(renderRow)}
                <SectionLabel>All currencies</SectionLabel>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <Text style={{ color: p.textMuted, padding: 16 }}>No currency matches “{query}”.</Text>
          }
          renderItem={({ item }) => renderRow(item)}
        />
      </SafeAreaView>
    </Modal>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  const p = usePalette();
  return (
    <Text
      style={{
        fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: p.textMuted,
        paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6,
      }}
    >
      {String(children).toUpperCase()}
    </Text>
  );
}
