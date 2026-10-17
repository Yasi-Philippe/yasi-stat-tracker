# Security model

Trazo treats the cloud as untrusted storage. Everything a user creates is encrypted on the device before it is written anywhere, and the keys never leave the user's devices in a usable form.

## Keys

```
password ──Argon2id (64 MiB, 3 passes, salt = SHA-256(email))──▶ master key
master key ──HKDF "auth"──▶ login secret      → sent to Firebase Auth instead of the password
master key ──HKDF "kek"───▶ password key      → never leaves the device
recovery key (160 random bits) ──HKDF──▶ recovery key-encryption key

data key (DEK, 32 random bytes)
  ├─ wrapped by the password key   ┐ stored together in users/{uid}
  ├─ wrapped by the recovery key   ┘ ("key envelope")
  └─HKDF──▶ chunk key (AES-256-GCM) · id key (HMAC-SHA256) · key fingerprint
```

- **Firebase never receives the password**, only a value derived from it that cannot be turned back into the password key. A compromised Firebase account therefore does not expose data.
- The salt is derived from the email, so a new device can derive the login secret before contacting the server.
- The **recovery key** is 160 random bits plus a typo checksum, shown once at sign-up as nine groups of four characters.

## Data

- Records (metrics, entries, charts, settings…) are grouped into **chunks**: one per metric per year, and one per kind of setting. Each chunk is JSON, compressed, then sealed with AES-256-GCM. The associated data binds each chunk to its slot, so a chunk cannot be moved and still open.
- Chunk ids are HMACs of their names, so the server cannot tell which metric or year a chunk holds.
- On the device, IndexedDB holds **only the same ciphertext**. The data key itself sits in:
  - Android: the Android Keystore (hardware-backed where available);
  - Linux: the system keyring through Electron `safeStorage`; if no keyring exists, it falls back to the browser store;
  - browser: a non-extractable WebCrypto key in IndexedDB.

## What the server can see

- The account's email (needed for login and emails), creation time, and sign-in times.
- How many chunks exist, their sizes, revision counters, and when they changed.
- The key envelope: two wrapped copies of the data key, the key fingerprint, and the Argon2 parameters.

It cannot see names, values, notes, formulas, charts or themes.

## Accounts

- **Open sign-up, strict isolation:** anyone can create an account. Each account can only read and write `users/{its uid}`, and must verify its email before storing data, so the reset email reaches a real inbox. Everything else in the database is closed.
- **Changing the password** re-wraps the data key without re-encrypting the data, and signs out other devices.
- **Forgot password:** the email link opens Firebase's reset page, and the user types a *temporary* password there. Firebase sees that password, so Trazo uses it only to sign in once. It then immediately replaces it with a login secret derived from a new password typed in the app, which Firebase never sees. The new password can't open the old data key, so the key is re-wrapped:
  - by any device that still holds it, the next time it logs in;
  - or with the recovery key.

  Someone who only controls the email can get into the account but cannot read anything. If the project lets the action URL point to Trazo's own reset page, the new password is derived on that page instead and the temporary step disappears.
- **Start over:** when neither a device nor the recovery key is available, the user may abandon the old key. The old cloud chunks are deleted, because they are unreadable.
- **Log out** deletes the device's local copy and its key. **Delete account** erases all cloud chunks, the key envelope and the login.

## Backups

The encrypted backup file contains the wrapped data keys and the sealed records. It opens with the password or recovery key that were valid when it was made. It never contains the email, only the salt derived from it. The CSV export is plain text, and the app says so before writing it.

## Hardening

- Production builds ship a strict Content-Security-Policy: scripts only from the app, WebAssembly allowed for Argon2, network only to Google's Firebase endpoints.
- Electron runs with context isolation, sandbox, no Node integration, a custom `app://` protocol with path checks, blocked navigation, and validated IPC.
- On Android, app backup and device-to-device transfer are disabled, cleartext traffic is off, and keystore entries are bound to their names.

## Known limits

- A malicious server could **withhold or roll back** chunks to an older version it saw before. It cannot forge or read them.
- The server learns usage patterns: when sync happens and how much data there is.
- If an attacker controls the email and then chooses "start over", the cloud copy is wiped. The legitimate user's devices still hold their full local copy and can restore from it, or from an encrypted backup.
- The strength of the protection is the strength of the password. Argon2id makes guessing slow, but not impossible for weak passwords.
