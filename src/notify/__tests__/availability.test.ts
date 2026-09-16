/**
 * The Expo Go import guard.
 *
 * This exists because of a crash that only appeared when the app was actually
 * launched on an Android emulator. In Expo Go on Android, *importing*
 * `expo-notifications` throws — its DevicePushTokenAutoRegistration side effect
 * runs at import time and hard-throws, because remote push was removed from
 * Expo Go in SDK 53. The app red-boxed on startup before rendering a screen.
 *
 * On iOS the identical import only warns, which is why bundling cleanly and
 * running on one platform proved nothing about the other.
 */

import {
  configureNotifications,
  deliver,
  getNotificationPermission,
  notificationsAvailable,
  requestNotificationPermission,
} from '../notifier';
import type { NotificationPlan } from '../policy';

const mockConstants: { appOwnership: string | null } = { appOwnership: null };
jest.mock('expo-constants', () => ({
  __esModule: true,
  get default() {
    return mockConstants;
  },
}));

const PLAN: NotificationPlan = {
  trigger: 'confirmed',
  title: 'Receipt confirmed',
  body: 'Blue Bottle Coffee, Northwind Traders',
  route: '/receipt/rcp_1',
  threadKey: 'northwind:rcp_1',
  companyId: 'northwind',
};

describe('inside Expo Go', () => {
  beforeEach(() => {
    mockConstants.appOwnership = 'expo';
  });

  it('reports notifications as unavailable', () => {
    expect(notificationsAvailable()).toBe(false);
  });

  it('configureNotifications resolves without loading the module', async () => {
    // The assertion is that this does not THROW. Loading expo-notifications
    // here is what crashed the app on Android.
    await expect(configureNotifications()).resolves.toBeUndefined();
  });

  it('permission queries answer denied rather than importing', async () => {
    await expect(getNotificationPermission()).resolves.toBe('denied');
    await expect(requestNotificationPermission()).resolves.toBe('denied');
  });

  it('deliver reports failure rather than pretending it sent', async () => {
    // It must return false, not true: a caller that believed this had delivered
    // would tell the user something the OS never showed them.
    await expect(deliver(PLAN)).resolves.toBe(false);
  });
});

describe('outside Expo Go (development or standalone build)', () => {
  it('reports notifications as available', () => {
    mockConstants.appOwnership = null;
    expect(notificationsAvailable()).toBe(true);
  });
});
