/** A small, deliberate palette. Light and dark are both first-class. */
import { useColorScheme } from 'react-native';

export interface Palette {
  bg: string; surface: string; surfaceAlt: string; border: string;
  text: string; textMuted: string;
  accent: string; accentText: string;
  neutral: string; pending: string; success: string; warning: string; danger: string;
  neutralBg: string; pendingBg: string; successBg: string; warningBg: string; dangerBg: string;
}

const light: Palette = {
  bg: '#F6F7F9', surface: '#FFFFFF', surfaceAlt: '#F0F2F5', border: '#DFE3E8',
  text: '#11181C', textMuted: '#5C6B73',
  accent: '#0A62C2', accentText: '#FFFFFF',
  neutral: '#5C6B73', pending: '#8A5B00', success: '#0F6B3C', warning: '#8A5B00', danger: '#A4252B',
  neutralBg: '#ECEFF1', pendingBg: '#FFF3D6', successBg: '#DFF3E6', warningBg: '#FFF3D6', dangerBg: '#FBE3E4',
};

const dark: Palette = {
  bg: '#0E1417', surface: '#171F24', surfaceAlt: '#1F282E', border: '#2C383F',
  text: '#ECEDEE', textMuted: '#9BA8B0',
  accent: '#4DA3FF', accentText: '#04121F',
  neutral: '#9BA8B0', pending: '#F0C36D', success: '#5FD39B', warning: '#F0C36D', danger: '#FF8A8F',
  neutralBg: '#232E35', pendingBg: '#3A2E14', successBg: '#12321F', warningBg: '#3A2E14', dangerBg: '#3A1B1D',
};

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}
