import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AppProvider } from '@/ui/app-context';

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AppProvider>
          <Stack>
            <Stack.Screen name="index" options={{ title: 'Receipts' }} />
            <Stack.Screen name="capture" options={{ title: 'New receipt', presentation: 'modal' }} />
            <Stack.Screen name="receipt/[localId]" options={{ title: 'Receipt' }} />
            <Stack.Screen name="scan" options={{ title: 'Scan code', presentation: 'modal' }} />
            <Stack.Screen name="crop" options={{ title: 'Crop receipt', presentation: 'modal' }} />
            <Stack.Screen name="settings" options={{ title: 'Session & simulation' }} />
          </Stack>
          <StatusBar style="auto" />
        </AppProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
