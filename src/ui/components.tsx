import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { Tone } from './receipt-status';
import { usePalette, type Palette } from './theme';

export function Badge({ label, tone, caption }: { label: string; tone: Tone; caption?: string }) {
  const p = usePalette();
  const fg = { neutral: p.neutral, pending: p.pending, success: p.success, warning: p.warning, danger: p.danger }[tone];
  const bg = { neutral: p.neutralBg, pending: p.pendingBg, success: p.successBg, warning: p.warningBg, danger: p.dangerBg }[tone];
  return (
    <View style={{ flex: 1 }}>
      {caption ? (
        <Text style={{ fontSize: 10, letterSpacing: 0.6, color: p.textMuted, marginBottom: 4, fontWeight: '700' }}>
          {caption.toUpperCase()}
        </Text>
      ) : null}
      <View style={{ backgroundColor: bg, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 6, alignSelf: 'flex-start' }}>
        <Text style={{ color: fg, fontWeight: '700', fontSize: 12 }}>{label}</Text>
      </View>
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return (
    <View style={[{ backgroundColor: p.surface, borderColor: p.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14 }, style]}>
      {children}
    </View>
  );
}

export function Button({
  title, onPress, variant = 'primary', disabled,
}: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean }) {
  const p = usePalette();
  const bg = disabled ? p.surfaceAlt : variant === 'primary' ? p.accent : variant === 'danger' ? p.dangerBg : p.surfaceAlt;
  const fg = disabled ? p.textMuted : variant === 'primary' ? p.accentText : variant === 'danger' ? p.danger : p.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => ({
        backgroundColor: bg, opacity: pressed && !disabled ? 0.75 : 1,
        paddingVertical: 11, paddingHorizontal: 16, borderRadius: 9, alignItems: 'center',
        borderWidth: variant === 'primary' ? 0 : StyleSheet.hairlineWidth, borderColor: p.border,
      })}
    >
      <Text style={{ color: fg, fontWeight: '700', fontSize: 14 }}>{title}</Text>
    </Pressable>
  );
}

export function Row({ children, gap = 8, style }: { children: React.ReactNode; gap?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', gap, alignItems: 'center' }, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  const p = usePalette();
  return (
    <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: p.textMuted, marginBottom: 8, marginTop: 4 }}>
      {String(children).toUpperCase()}
    </Text>
  );
}

export function Muted({ children }: { children: React.ReactNode }) {
  const p = usePalette();
  return <Text style={{ color: p.textMuted, fontSize: 13, lineHeight: 19 }}>{children}</Text>;
}

export function Title({ children }: { children: React.ReactNode }) {
  const p = usePalette();
  return <Text style={{ color: p.text, fontSize: 17, fontWeight: '700' }}>{children}</Text>;
}

export function Banner({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const p: Palette = usePalette();
  const bg = { neutral: p.neutralBg, pending: p.pendingBg, success: p.successBg, warning: p.warningBg, danger: p.dangerBg }[tone];
  const fg = { neutral: p.neutral, pending: p.pending, success: p.success, warning: p.warning, danger: p.danger }[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 9, padding: 11 }}>
      <Text style={{ color: fg, fontSize: 13, lineHeight: 19, fontWeight: '600' }}>{children}</Text>
    </View>
  );
}
