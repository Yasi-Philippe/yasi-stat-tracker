/** What the app needs from the device it runs on. One implementation per shell. */

export interface SecretStore {
  /** How well secrets are protected at rest on this device. */
  readonly protection: 'hardware' | 'os-keyring' | 'app-sandbox' | 'browser';
  get(name: string): Promise<Uint8Array | null>;
  set(name: string, value: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface ScheduledReminder {
  /** Stable positive 31-bit id. */
  id: number;
  at: Date;
  title: string;
  body: string;
}

export interface Notifier {
  /** Whether this platform can schedule reminders while the app is closed. */
  readonly canSchedule: boolean;
  permission(): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission(): Promise<boolean>;
  /** Replaces every scheduled reminder with this list. */
  replaceAll(reminders: ScheduledReminder[]): Promise<void>;
}

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

export interface FileIO {
  /** Saves or shares a file. Resolves false if the user cancelled. */
  save(name: string, mime: string, data: Uint8Array | string): Promise<boolean>;
  open(accept: string[]): Promise<PickedFile | null>;
}

export interface Platform {
  kind: 'web' | 'android' | 'electron';
  secrets: SecretStore;
  notifier: Notifier;
  files: FileIO;
  haptic(kind: 'light' | 'success' | 'warning'): void;
  openExternal(url: string): void;
  /** Called when the system back button is pressed; return true if handled. */
  onBack(handler: () => boolean): () => void;
}
