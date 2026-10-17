# Setting up your own Trazo cloud

Trazo syncs through a Firebase project that **you** own. On the free Spark plan there is no billing account, so it can never cost anything. Firebase only ever stores encrypted data, see [SECURITY.md](SECURITY.md).

You need a Google account, Node 22, and Java 21 if you want to run the local emulators.

## 1. Create the project

1. Go to <https://console.firebase.google.com> → **Add project**. Any name. Google Analytics: **off**.
2. Stay on the **Spark (free)** plan. Never add a billing account.

## 2. Register the app and fill `.env`

1. Project overview → **Add app** → **Web** (`</>`). Any nickname. Hosting can be set up later.
2. Copy the config values into a new `.env` file at the repository root (start from `.env.example`):

   ```
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_PROJECT_ID=...
   VITE_FIREBASE_AUTH_DOMAIN=...
   VITE_FIREBASE_APP_ID=...
   ```

   `.env` is gitignored. These values are not secrets, since security comes from the rules and the encryption, but keeping them out of a public repository is tidy.

## 3. Turn on email sign-in

**Build → Authentication → Get started → Sign-in method → Email/Password → Enable**. Leave "Email link (passwordless)" **off**.

A password policy (Authentication → Settings) is optional. The app enforces its own rules, and the secret it sends to Firebase satisfies any policy.

## 4. Create the database and deploy the rules

1. **Build → Firestore Database → Create database**, in production mode, at a location near you (for example `eur3`).
2. From the repository:

   ```bash
   npx firebase login
   npx firebase use --add          # pick your project; writes .firebaserc (gitignored)
   npx firebase deploy --only firestore
   ```

   This uploads `firebase/firestore.rules` and the index settings.

## 5. Password resets

Nothing to set up: "I forgot my password" works out of the box with Firebase's own reset page.

1. The email link opens Firebase's page. Type a **temporary** password there; it is used only once.
2. Back in Trazo, tap **I've set it**. Log in with the temporary password, then choose the real new password.

Firebase's page sends whatever is typed there to Google as is, which is why that password only serves to get back in once. Trazo replaces it immediately with a secret derived from the real new password, which never leaves the device.

### Optional: Trazo's own reset page

Some Firebase projects allow pointing reset emails at a custom page, which saves the temporary-password step. New projects usually refuse it with `EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`. In that case just skip this; the flow above works.

1. Run `npm run build:action` and then `npx firebase deploy --only hosting`. The page is published at `https://<project-id>.web.app`.
2. Go to **Authentication → Templates → Password reset → ✏️ → Customize action URL** and enter `https://<project-id>.firebaseapp.com/`.
3. Only if that saved: add `VITE_TRAZO_RESET_PAGE=1` to `.env`, then rebuild the apps.

## 6. Build the apps

```bash
npm run android:apk        # → release/Trazo-<version>.apk
npm run electron:build     # → release/Trazo-<version>-x86_64.AppImage and .deb
```

The first Android build creates a signing key: `android/trazo-release.jks` plus `android/keystore.properties`. **Back up both files somewhere safe and private.** Android only accepts updates signed with the same key. If you lose it, you have to uninstall the app (and log in again) to install a newer version.

Installing on a phone: copy the APK over and open it. Android asks once to allow installs from that source.

## 7. Your account

Open Trazo → **Create account**, store the recovery key it shows, open the verification email, and you're in.

## 8. Sharing the app

Send people the APK or AppImage. Each person creates their own account with their own password and recovery key, and gets an empty sandbox of their own. Everyone's data is encrypted with their own keys: nobody can see anyone else's, not even you as the owner of the Firebase project.

Anyone who has the app can sign up. If you ever need to stop someone, **Authentication → Users** in the console lets you disable or delete an account.

## Free plan limits

Everyone using your copy of the app shares these limits. Trazo stores entries as one encrypted chunk per metric per year, so normal use stays far below them.

| Resource | Free limit | Typical use |
|---|---|---|
| Firestore storage | 1 GiB | A few MB per person, even after years |
| Document reads | 50,000 / day | A full restore of years of data: a few hundred |
| Document writes | 20,000 / day | Daily logging: a handful |
| Auth daily users | 3,000 | — |
| Password-reset emails | 150 / day | — |

If a limit is ever reached, sync pauses until the daily reset (midnight Pacific time) and the app keeps working offline. Nothing is billed.

## Forgotten passwords

**Log in → I forgot my password** sends the reset email. After setting a new password on the reset page:

- logging in on another device that still has the data unlocks everything automatically;
- otherwise the recovery key unlocks it;
- without either, the data cannot be opened by anyone. The account can then start over empty.
