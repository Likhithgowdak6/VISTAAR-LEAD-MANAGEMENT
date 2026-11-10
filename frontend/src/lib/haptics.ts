import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

/**
 * Native mobile haptic feedback helper for Vistaar CRM.
 * Uses native Capacitor Haptics on Android, with safe fallback to `navigator.vibrate`
 * and graceful no-ops during headless tests or unsupported environments.
 */
export const hapticImpact = async (style: 'light' | 'medium' | 'heavy' = 'light'): Promise<void> => {
  try {
    const impactMap = {
      light: ImpactStyle.Light,
      medium: ImpactStyle.Medium,
      heavy: ImpactStyle.Heavy,
    };
    await Haptics.impact({ style: impactMap[style] });
  } catch {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(style === 'heavy' ? 35 : style === 'medium' ? 22 : 10);
    }
  }
};

export const hapticSelection = async (): Promise<void> => {
  try {
    await Haptics.selectionChanged();
  } catch {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(8);
    }
  }
};

export const hapticNotification = async (type: 'success' | 'warning' | 'error' = 'success'): Promise<void> => {
  try {
    const notifMap = {
      success: NotificationType.Success,
      warning: NotificationType.Warning,
      error: NotificationType.Error,
    };
    await Haptics.notification({ type: notifMap[type] });
  } catch {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(type === 'error' ? [30, 40, 30] : [15, 25]);
    }
  }
};

