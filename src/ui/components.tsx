import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { Tone } from './receipt-status';
import { usePalette, type Palette } from './theme';

export function Badge({ label, tone, caption }: { label: string; tone: Tone; caption?: string }) {
  const p = usePalette();
  const fg = { neutral: p.neutral, pending: p.pending, success: p.success, warning: p.warning, danger: p.danger }[tone];
  const bg = { neutral: p.neutralBg, pending: p.pendingBg, success: p.successBg, warning: p.warningBg, danger: p.dangerBg }[tone];
  return (
    // Grouped for assistive tech: read as separate nodes, the caption and the
    // label are two disconnected words ("On the server" ... "Not received").
    // Together they are the sentence that carries the meaning.
    <View
      style={{ flex: 1 }}
      accessible
      accessibilityLabel={caption ? `${caption}: ${label}` : label}
    >
      {caption ? (
        <Text
          importantForAccessibility="no"
          style={{ fontSize: 10, letterSpacing: 0.6, color: p.textMuted, marginBottom: 4, fontWeight: '700' }}
        >
          {caption.toUpperCase()}
        </Text>
      ) : null}
      <View style={{ backgroundColor: bg, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 6, alignSelf: 'flex-start' }}>
        <Text importantForAccessibility="no" style={{ color: fg, fontWeight: '700', fontSize: 12 }}>{label}</Text>
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
  title, onPress, variant = 'primary', disabled, accessibilityLabel, selected,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  /** Overrides the visible title when a control needs more context spoken. */
  accessibilityLabel?: string;
  /** Set when the button behaves as a choice, so its state is announced. */
  selected?: boolean;
}) {
  const p = usePalette();
  const bg = disabled ? p.surfaceAlt : variant === 'primary' ? p.accent : variant === 'danger' ? p.dangerBg : p.surfaceAlt;
  const fg = disabled ? p.textMuted : variant === 'primary' ? p.accentText : variant === 'danger' ? p.danger : p.text;
  return (
    <Pressable
      accessibilityRole={selected === undefined ? 'button' : 'radio'}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled, selected }}
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
    // 'alert' is the only announcement role React Native defines ('status' is
    // not one). For the non-error tones a polite live region does the same job
    // on Android without interrupting whatever is being read.
    <View
      accessible
      accessibilityRole={tone === 'danger' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'danger' ? 'assertive' : 'polite'}
      style={{ backgroundColor: bg, borderRadius: 9, padding: 11 }}
    >
      <Text style={{ color: fg, fontSize: 13, lineHeight: 19, fontWeight: '600' }}>{children}</Text>
    </View>
  );
}
