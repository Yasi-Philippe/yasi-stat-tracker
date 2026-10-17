/**
 * Firebase wiring. Configuration comes from build-time environment variables
 * (see .env.example) so no project identifiers live in the repository. If the
 * variables are missing the app runs in demo mode only.
 */

import { type FirebaseApp, type FirebaseOptions, getApps, initializeApp } from 'firebase/app';
import { type Auth, connectAuthEmulator, indexedDBLocalPersistence, initializeAuth, inMemoryPersistence } from 'firebase/auth';
import { connectFirestoreEmulator, type Firestore, initializeFirestore, memoryLocalCache } from 'firebase/firestore';

export interface FirebaseHandles {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
}

export interface FirebaseEnv {
  options: FirebaseOptions;
  /** Host of the local emulators, e.g. "127.0.0.1", or null for production. */
  emulatorHost: string | null;
}

type EnvRecord = Record<string, string | undefined>;

export function readFirebaseEnv(env: EnvRecord = import.meta.env as EnvRecord): FirebaseEnv | null {
  const apiKey = env.VITE_FIREBASE_API_KEY;
  const projectId = env.VITE_FIREBASE_PROJECT_ID;
  if (!apiKey || !projectId) return null;
  return {
    options: {
      apiKey,
      projectId,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
      appId: env.VITE_FIREBASE_APP_ID,
    },
    emulatorHost: env.VITE_FIREBASE_EMULATOR_HOST || null,
  };
}

let handles: FirebaseHandles | null = null;

export function firebase(config: FirebaseEnv, opts: { persistence?: 'device' | 'memory'; name?: string } = {}): FirebaseHandles {
  if (handles && !opts.name) return handles;
  const name = opts.name ?? '[DEFAULT]';
  const app = getApps().find((a) => a.name === name) ?? initializeApp(config.options, name);
  // initializeAuth without a popup/redirect resolver: email + password only,
  // which also avoids the hidden iframe that stalls inside app WebViews.
  const auth = initializeAuth(app, {
    persistence: opts.persistence === 'memory' ? inMemoryPersistence : [indexedDBLocalPersistence, inMemoryPersistence],
  });
  // Our own encrypted store is the offline cache; Firestore's would only duplicate ciphertext.
  const db = initializeFirestore(app, { localCache: memoryLocalCache() });
  if (config.emulatorHost) {
    connectAuthEmulator(auth, `http://${config.emulatorHost}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, config.emulatorHost, 8080);
  }
  const h = { app, auth, db };
  if (!opts.name) handles = h;
  return h;
}
