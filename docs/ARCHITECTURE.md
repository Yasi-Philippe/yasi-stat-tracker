# Architecture

One React + TypeScript web app, wrapped by Capacitor for Android and Electron for Linux. All logic lives in the web app. The shells only provide secure key storage, notifications, files and windows.

```
src/
  core/            pure logic, no UI, unit-tested
    model/         types of the sandbox (metrics, formulas, periods, charts, themes) and calendar maths
    crypto/        encodings, WebCrypto + Argon2 wrappers, key hierarchy, recovery key
    vault/         records, HLC clock, encrypted chunks, IndexedDB store, the in-memory Vault
    sync/          RemoteStore interface, Firestore implementation, sync engine
    account/       register / login / recovery / password change on Firebase Auth
    engine/        formula language (lexer, parser, evaluator, functions) and chart evaluation
    data/          typed access to the vault, slugs and references, starter packs, demo data
    io/            CSV/XLSX reading, import plans, encrypted backups, CSV export
    reminders.ts   reminder planning
  app/             session state machine, router, React hooks
  platform/        web / Android / Electron implementations of secrets, notifications, files
  ui/              screens and components (auth, today, charts, metric, studio, settings, theme)
  styles/          base and component CSS, bundled fonts
action/            standalone email action page (password reset, verification) for Firebase Hosting
electron/          Electron main process and preload
android/           Capacitor Android project, including the SecureKey Keystore plugin
firebase/          Firestore security rules and index settings
```

## Data flow

1. The UI calls typed functions in `core/data/repo.ts`, for example `setEntry(vault, metric, date, value)`.
2. The **Vault** updates memory synchronously, stamps the record with a hybrid logical clock, and marks its chunk dirty.
3. A moment later the chunk is re-encrypted and written to IndexedDB.
4. The **SyncEngine** pulls chunks changed since its cursor, then pushes dirty chunks with compare-and-swap on a revision number. If another device wrote first, the two versions are merged record by record (last writer wins by HLC stamp) and pushed again.
5. React re-renders through `useSyncExternalStore` on the vault's version counter. Charts re-evaluate through a fresh engine `Workspace` per data version.

## The sandbox model

- **Metrics**: values entered by hand. They are *daily*, *monthly* or *occasional*. They either keep gaps (weight) or hold their value until the next entry (balances, height).
- **Formulas**: named expressions over metrics and other formulas. Cycles are detected.
- **Period sets**: named date ranges. *Campaigns* are started and stopped from Today; *chapters* are consecutive parts of life.
- **Charts**: specs with a kind, an x-axis mode (dates, days since start, calendar buckets, periods), series formulas, an optional period filter or shading, and a default view.
- **Dashboards** order charts. **Themes** are token sets the UI turns into CSS variables and ECharts styles.

Everything is a record in the vault, so it syncs and is encrypted like the data itself.

## Formula engine

A hand-written lexer and Pratt parser produce an AST with source spans, used for precise error underlining. Values are series (sorted day numbers in typed arrays, optionally step-filled), numbers, or date functions. Operations align series on dates according to their fill. Charts are evaluated into renderer-agnostic data (time, elapsed, category, OHLC, waterfall, small multiples), which `ui/charts/buildOption.ts` turns into ECharts options using the active theme. See [FORMULAS.md](FORMULAS.md) for the language.

## Accounts and keys

See [SECURITY.md](SECURITY.md). `app/session.ts` drives the screens:

booting → welcome → (recovery key) → verify email → restoring → ready

It also handles the locked state after a password reset, re-authentication, log out and account deletion.

## Shells

| | Android (Capacitor) | Linux (Electron) | Browser |
|---|---|---|---|
| Key storage | Keystore plugin `SecureKey` | `safeStorage` (system keyring) | non-extractable WebCrypto key |
| Reminders | local notifications, inexact | — | — |
| Files | share sheet / system picker | native dialogs | download / file input |
| Origin | `https://localhost` | `app://trazo` | dev server |
