# Development

## Requirements

- Node 22 and npm.
- Java 21: for the Firebase emulators and Android builds. Set `JAVA_HOME`.
- Android SDK with platform 35/36: for the APK. Set `ANDROID_HOME`, or keep it at `~/Android/Sdk`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Web app with hot reload on http://localhost:5180 |
| `npm test` | Unit tests (Vitest): crypto, vault, sync, engine, import, templates |
| `npm run typecheck` | TypeScript, no emit |
| `npm run test:emulator` | Account lifecycle against the Auth + Firestore emulators with the real security rules |
| `npm run emulators` | Start the emulators for manual testing |
| `npm run build` | Typecheck and production build into `dist/` |
| `npm run build:action` | Build the email action page into `dist-action/` |
| `npm run electron:dev` | Electron window on the dev server |
| `npm run electron:smoke` | Build, then run Electron's hidden self-test (prints a JSON report) |
| `npm run electron:build` | AppImage and `.deb` in `release/` |
| `npm run android:apk` | Signed APK in `release/` (`SKIP_WEB_BUILD=1` reuses `dist/`) |

## Working against the emulators

Create `.env.local` (gitignored):

```
VITE_FIREBASE_API_KEY=demo-key
VITE_FIREBASE_PROJECT_ID=demo-trazo
VITE_FIREBASE_EMULATOR_HOST=127.0.0.1
```

Then run `npm run emulators` in one terminal and `npm run dev` in another. Verification and password-reset links appear in the emulator log instead of being emailed. The emulator's REST API accepts the header `Authorization: Bearer owner`, which bypasses the rules, for inspecting what is stored.

## Notes

- **Privacy:** never commit personal data. Tests and the demo use generated data only. `private/` is gitignored for notes that must stay local.
- **Electron from an editor terminal:** some editors export `ELECTRON_RUN_AS_NODE=1`, which turns Electron into plain Node. `npm run electron:dev` clears it; for other commands prefix `env -u ELECTRON_RUN_AS_NODE`.
- **Wayland:** the `.deb` launcher passes `--ozone-platform=x11`, because Electron 44 has window-frame issues on GNOME Wayland. When starting the AppImage by hand, add the same flag for a title bar.
- **Crypto constants:** the `yst/v1/...` strings in `src/core/crypto` and `src/core/vault` are protocol constants. Changing one makes existing data unreadable.
