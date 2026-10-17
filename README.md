# Trazo

**Track anything. Own every number.**

Trazo is a personal metrics tracker for Android and Linux. You decide what to track, how it is computed and how it is drawn. The data is end-to-end encrypted, works offline, and syncs between your devices through a free cloud backend that never sees it.

## What it does

- **A sandbox, not a fixed app.** Define your own metrics (daily, monthly or occasional), formulas over them (`weight / (height / 100) ^ 2`, `bank + fill(fund_a, 0)`), named periods (diet campaigns, places you lived) and charts, then group charts into dashboards.
- **Logging in seconds.** The Today screen pre-fills yesterday's value so you adjust instead of typing. Backfill any day, fix past entries, start and stop campaigns with one tap. Optional reminders fire only on days you forgot.
- **Charts that hold up.** Lines, areas, bars, waterfalls and candlesticks. Zoom and pan, browse by year, quarter or month, edit the axes, shade periods, compare investments from their own day one, or one small chart per campaign.
- **Make it yours.** Six built-in themes, plus a theme studio for every colour, font, corner, glow and chart line.
- **Bring your history.** Import CSV or Excel with column mapping, date and decimal detection, and a preview before anything is written.
- **Private by construction.** Your password never leaves the device. Data is sealed with AES-256-GCM before it is stored or synced. See [docs/SECURITY.md](docs/SECURITY.md).
- **Free.** Runs on the Firebase free plan, in a cloud project you control. Nothing is ever billed.

## Platforms

| Platform | How |
|---|---|
| Android | Signed APK, installed directly (`npm run android:apk`) |
| Linux desktop | AppImage and `.deb` (`npm run electron:build`) |
| Any browser | Development and demo (`npm run dev`) |

## Quick start

```bash
npm install
npm run dev          # http://localhost:5180 — "Explore with demo data" works without any cloud
```

To use real accounts and sync, create your own free Firebase project and put its web config in `.env`. It takes about fifteen minutes; follow [docs/SETUP.md](docs/SETUP.md).

## Documentation

- [docs/SETUP.md](docs/SETUP.md): your own cloud, first account, sharing the app, building it
- [docs/FORMULAS.md](docs/FORMULAS.md): the formula language
- [docs/SECURITY.md](docs/SECURITY.md): how the encryption works and what the server can see
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the code is organised
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): scripts, tests, emulators

## Built with

React and TypeScript (Vite), Apache ECharts, Dexie (IndexedDB), Firebase Auth and Firestore, WebCrypto and Argon2id (hash-wasm), Capacitor for Android, Electron for Linux.
