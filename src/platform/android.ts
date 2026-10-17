/** Android (Capacitor) implementation. */

import { App } from '@capacitor/app';
import { registerPlugin, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Share } from '@capacitor/share';
import { fromBase64Url, toBase64Url, utf8 } from '../core/crypto/encoding';
import type { Notifier, Platform, ScheduledReminder, SecretStore } from './types';
import { BrowserFiles, runBackHandlers, webPlatform } from './web';

/** Native plugin backed by the Android Keystore (see android/…/SecureKeyPlugin.kt). */
interface SecureKeyPlugin {
  get(opts: { name: string }): Promise<{ value: string | null }>;
  set(opts: { name: string; value: string }): Promise<void>;
  remove(opts: { name: string }): Promise<void>;
}

const SecureKey = registerPlugin<SecureKeyPlugin>('SecureKey');

class KeystoreSecrets implements SecretStore {
  readonly protection = 'hardware' as const;
  async get(name: string): Promise<Uint8Array | null> {
    const { value } = await SecureKey.get({ name });
    return value ? fromBase64Url(value) : null;
  }
  async set(name: string, value: Uint8Array): Promise<void> {
    await SecureKey.set({ name, value: toBase64Url(value) });
  }
  async delete(name: string): Promise<void> {
    await SecureKey.remove({ name });
  }
}

const CHANNEL = 'reminders';

class AndroidNotifier implements Notifier {
  readonly canSchedule = true;
  private channelReady = false;

  async permission(): Promise<'granted' | 'denied' | 'prompt'> {
    const p = await LocalNotifications.checkPermissions();
    return p.display === 'granted' ? 'granted' : p.display === 'denied' ? 'denied' : 'prompt';
  }

  async requestPermission(): Promise<boolean> {
    return (await LocalNotifications.requestPermissions()).display === 'granted';
  }

  async replaceAll(reminders: ScheduledReminder[]): Promise<void> {
    if (!this.channelReady) {
      await LocalNotifications.createChannel({
        id: CHANNEL,
        name: 'Reminders',
        description: 'Reminders to log your values',
        importance: 4,
        vibration: true,
      });
      this.channelReady = true;
    }
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length) {
      await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    }
    if (!reminders.length) return;
    await LocalNotifications.schedule({
      notifications: reminders.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        channelId: CHANNEL,
        smallIcon: 'ic_stat_trazo',
        schedule: { at: r.at, allowWhileIdle: true },
        // Inexact is fine for reminders, and exact alarms would open a system settings screen.
        isExactNotification: false,
      })),
    });
  }
}

/** Light icons on dark themes, dark icons on light ones. */
export function setSystemBarScheme(scheme: 'dark' | 'light'): void {
  void SystemBars.setStyle({ style: scheme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => undefined);
}

export function androidPlatform(): Platform {
  const base = webPlatform();
  void App.addListener('backButton', () => {
    if (runBackHandlers()) return;
    if (window.history.length > 1 && location.hash && location.hash !== '#/today') window.history.back();
    else void App.minimizeApp();
  });
  return {
    ...base,
    kind: 'android',
    secrets: new KeystoreSecrets(),
    notifier: new AndroidNotifier(),
    files: {
      async save(name, mime, data) {
        const bytes = typeof data === 'string' ? utf8(data) : data;
        const written = await Filesystem.writeFile({
          path: name,
          data: toBase64(bytes),
          directory: Directory.Cache,
        });
        try {
          await Share.share({ title: name, files: [written.uri], dialogTitle: `Save or send (${mime})` });
          return true;
        } catch {
          return false;
        }
      },
      open: (accept) => new BrowserFiles().open(accept),
    },
    haptic(kind) {
      if (kind === 'light') void Haptics.impact({ style: ImpactStyle.Light });
      else void Haptics.notification({ type: kind === 'success' ? NotificationType.Success : NotificationType.Warning });
    },
    openExternal(url) {
      window.open(url, '_system');
    },
  };
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
