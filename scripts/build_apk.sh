#!/usr/bin/env bash
# Builds the signed release APK: web build, Capacitor sync, Gradle assembleRelease.
# Output: release/Trazo-<version>.apk (version from package.json).
# SKIP_WEB_BUILD=1 reuses the existing dist/ instead of running the web build.
#
# The first run creates the release keystore android/trazo-release.jks and its passwords in
# android/keystore.properties. Back both up and never commit them: without them no future
# build can update an installed copy of the app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
KEYSTORE="$ANDROID_DIR/trazo-release.jks"
KEYSTORE_PROPS="$ANDROID_DIR/keystore.properties"

die() {
  echo "error: $*" >&2
  exit 1
}

java_major() {
  "$1/bin/java" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p'
}

# --- JDK 21 ---------------------------------------------------------------------------
if [[ -n "${JAVA_HOME:-}" && "$(java_major "$JAVA_HOME" 2>/dev/null)" != "21" ]]; then
  echo "note: JAVA_HOME=$JAVA_HOME is not a JDK 21, looking elsewhere" >&2
  JAVA_HOME=""
fi
if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in "$HOME"/tools/jdk-21*; do
    if [[ -x "$candidate/bin/java" ]]; then JAVA_HOME="$candidate"; fi
  done
fi
[[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]] ||
  die "JDK 21 not found. Install one and set JAVA_HOME, e.g. export JAVA_HOME=/path/to/jdk-21"
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

# --- Android SDK ----------------------------------------------------------------------
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
[[ -d "$ANDROID_HOME/platforms" ]] ||
  die "Android SDK not found at $ANDROID_HOME. Set ANDROID_HOME to your SDK directory."

echo "JDK:         $JAVA_HOME"
echo "Android SDK: $ANDROID_HOME"

# --- Web app and native project -------------------------------------------------------
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
if [[ "${SKIP_WEB_BUILD:-}" == "1" ]]; then
  [[ -f dist/index.html ]] || die "SKIP_WEB_BUILD=1 but dist/index.html does not exist"
  echo "==> Reusing existing dist/ (SKIP_WEB_BUILD=1)"
else
  echo "==> Building web app (Trazo $VERSION)"
  npx vite build
fi
echo "==> Syncing Capacitor"
npx cap sync android

# --- Release keystore (first run only) ------------------------------------------------
NEW_KEYSTORE=0
if [[ ! -f "$KEYSTORE_PROPS" ]]; then
  [[ ! -f "$KEYSTORE" ]] ||
    die "$KEYSTORE exists but android/keystore.properties is missing. Restore it from your backup."
  echo "==> Creating release keystore"
  KS_PASS="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-40)"
  [[ ${#KS_PASS} -ge 32 ]] || die "could not generate a keystore password"
  export KS_PASS
  (
    umask 077
    keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -alias trazo \
      -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Trazo" \
      -storepass:env KS_PASS -keypass:env KS_PASS
    cat >"$KEYSTORE_PROPS" <<EOF
storeFile=trazo-release.jks
storePassword=$KS_PASS
keyAlias=trazo
keyPassword=$KS_PASS
EOF
  )
  unset KS_PASS
  NEW_KEYSTORE=1
fi

# --- Gradle (retried: dependency downloads can drop on a flaky network) ----------------
echo "==> Building release APK"
cd "$ANDROID_DIR"
for attempt in 1 2 3; do
  if ./gradlew assembleRelease; then break; fi
  [[ $attempt -lt 3 ]] || die "Gradle build failed"
  echo "Gradle failed (attempt $attempt of 3), retrying in case a download dropped..." >&2
  sleep 10
done

APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
[[ -f "$APK" ]] || die "signed APK not found at $APK"
APKSIGNER="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -n 1 || true)"
if [[ -n "$APKSIGNER" ]]; then
  "$APKSIGNER" verify "$APK" || die "APK signature verification failed"
fi

OUT_DIR="$ROOT/release"
OUT="$OUT_DIR/Trazo-$VERSION.apk"
mkdir -p "$OUT_DIR"
cp "$APK" "$OUT"

echo
echo "APK:  $OUT"
echo "Size: $(du -h "$OUT" | cut -f1)"
echo
echo "############################################################################"
if [[ $NEW_KEYSTORE -eq 1 ]]; then
  echo "#  NEW RELEASE KEYSTORE CREATED.                                           #"
fi
echo "#  BACK UP android/trazo-release.jks AND android/keystore.properties       #"
echo "#  somewhere safe and private (never in git). If they are lost, no future  #"
echo "#  version can be installed as an update: users would have to uninstall    #"
echo "#  the app and lose its local data.                                        #"
echo "############################################################################"
