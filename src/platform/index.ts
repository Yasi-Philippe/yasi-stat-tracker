import { Capacitor } from '@capacitor/core';
import { androidPlatform, setSystemBarScheme } from './android';
import { setSchemeListener } from '../ui/theme/applyTheme';
import { electronPlatform } from './electron';
import type { Platform } from './types';
import { webPlatform } from './web';

export type { Platform } from './types';

let current: Platform | null = null;

export function platform(): Platform {
  if (current) return current;
  if (typeof window !== 'undefined' && window.trazoNative) current = electronPlatform(window.trazoNative);
  else if (Capacitor.getPlatform() === 'android') {
    current = androidPlatform();
    setSchemeListener(setSystemBarScheme);
  }
  else current = webPlatform();
  return current;
}
