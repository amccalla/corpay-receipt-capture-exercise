/**
 * The native half of push completion.
 *
 * Deliberately thin. Every decision — whether to notify at all, what the copy
 * says, what must never appear in it — lives in `policy.ts`, which is pure and
 * therefore testable. This file only knows how to ask the OS for permission and
 * hand it a payload. If you find yourself adding an `if` here, it probably
 * belongs in the policy.
 *
 * WHY LOCAL NOTIFICATIONS AND NOT REMOTE PUSH: a remote push needs a push
 * service, a device-token registry, and a server that can reach it — none of
 * which a deterministic in-process fake can honestly provide. A local
 * notification scheduled the moment the sync engine observes a server
 * transition demonstrates the same client-side behaviour (permission handling,
 * deep link, collapse keys, lock-screen privacy) without pretending to
 * infrastructure that is not there. What it does NOT demonstrate is the case
 * that actually matters in production: a completion arriving while the app is
 * dead. That is stated plainly in the README rather than glossed over.
 */

import type { ReceiptDraft } from '../domain/types';
import { planNotification, type NotificationPlan } from './policy';

export type PermissionState = 'granted' | 'denied' | 'undetermined';

/**
 * Configure foreground presentation once, at startup.
 *
 * Receipts confirm while the user is often looking at the very list that
 * already shows it, so a banner would be noise. We suppress the banner in the
 * foreground and let the in-app UI speak for itself; the notification still
 * lands in the tray for when they look later.
 */
export async function configureNotifications(): Promise<void> {
  const Notifications = await import('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

export async function getNotificationPermission(): Promise<PermissionState> {
  try {
    const Notifications = await import('expo-notifications');
    const { status } = await Notifications.getPermissionsAsync();
    return status === 'granted' ? 'granted' : status === 'denied' ? 'denied' : 'undetermined';
  } catch {
    // Web, or a build without the module. Not an error: the app works fine
    // without notifications, it simply cannot offer them.
    return 'denied';
  }
}

/**
 * Ask only when we have something worth asking for.
 *
 * The prompt is deliberately NOT fired at launch. A permission request with no
 * context is the one most users decline, and on iOS a denial is effectively
 * permanent — you get one chance. We ask the first time a receipt is actually
 * queued, when "tell me when this is confirmed" is a proposition the user can
 * evaluate.
 */
export async function requestNotificationPermission(): Promise<PermissionState> {
  try {
    const Notifications = await import('expo-notifications');
    const existing = await Notifications.getPermissionsAsync();
    if (existing.status === 'granted') return 'granted';
    // Never re-prompt after an explicit denial: iOS will not show the dialog
    // again, so the call silently returns denied and we would just be lying to
    // the caller about having asked.
    if (!existing.canAskAgain) return 'denied';

    const { status } = await Notifications.requestPermissionsAsync();
    return status === 'granted' ? 'granted' : status === 'denied' ? 'denied' : 'undetermined';
  } catch {
    return 'denied';
  }
}

/**
 * Deliver a plan. Returns true only if something was actually scheduled, so
 * callers cannot report success for a notification the OS refused.
 */
export async function deliver(plan: NotificationPlan): Promise<boolean> {
  if ((await getNotificationPermission()) !== 'granted') return false;

  try {
    const Notifications = await import('expo-notifications');
    await Notifications.scheduleNotificationAsync({
      content: {
        title: plan.title,
        body: plan.body,
        // `data` is not rendered, so the route is safe here. The amount is
        // still absent by policy — see policy.ts.
        data: { route: plan.route, companyId: plan.companyId },
        // Collapses repeated updates for one receipt into a single entry
        // instead of stacking them up.
        ...(plan.threadKey ? { threadIdentifier: plan.threadKey } : {}),
      },
      trigger: null, // immediate
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The one call the sync layer makes. Compares two states of a draft and
 * delivers a notification if — and only if — the pure policy says one is
 * warranted.
 */
export async function notifyOnChange(
  previous: ReceiptDraft,
  next: ReceiptDraft,
  companyName: string,
): Promise<NotificationPlan | null> {
  const plan = planNotification(previous, next, companyName);
  if (!plan) return null;
  const delivered = await deliver(plan);
  return delivered ? plan : null;
}

/**
 * Route a tapped notification. Returns the deep-link target, or null when the
 * payload is not one of ours — notification data is attacker-influenceable in
 * the general case, so the route is validated rather than followed blindly.
 */
export function routeFromNotificationData(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const route = (data as Record<string, unknown>).route;
  if (typeof route !== 'string') return null;
  // Only ever an in-app receipt path. Anything else is refused.
  return /^\/receipt\/[A-Za-z0-9_-]+$/.test(route) ? route : null;
}
