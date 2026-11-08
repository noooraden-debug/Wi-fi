#!/usr/bin/env bash
# بناء APK لتطبيق WiFi Hub — بدون Gradle (aapt2 + d8 + apksigner)
# الاستخدام:  ./build.sh [--config path/to/app.json] [--out dir]
set -euo pipefail

SDK="${ANDROID_HOME:-/opt/android}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
PROJ="$(cd "$(dirname "$0")" && pwd)"

CONFIG="$PROJ/../config/app.json"
OUT="$PROJ/dist"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    *) echo "Unknown arg $1"; exit 1;;
  esac
done

echo "▶ إعدادات البناء: $CONFIG"
CFG_URL=$(node -e "console.log(require('$CONFIG').configUrl||'')")
READ_TOKEN=$(node -e "console.log(require('$CONFIG').readToken||'')")
REQ_TOKEN=$(node -e "console.log(require('$CONFIG').requestToken||'')")

# متغيّرات البيئة تتغلّب على ملف الإعدادات (تُستخدم في GitHub Actions)
[ -n "${WIFIHUB_CONFIG_URL:-}" ] && CFG_URL="$WIFIHUB_CONFIG_URL"
[ -n "${WIFIHUB_READ_TOKEN:-}" ] && READ_TOKEN="$WIFIHUB_READ_TOKEN"
[ -n "${WIFIHUB_REQUEST_TOKEN:-}" ] && REQ_TOKEN="$WIFIHUB_REQUEST_TOKEN"
echo "  configUrl: ${CFG_URL:-(غير محدد)}"

WORK="$PROJ/build"
rm -rf "$WORK"; mkdir -p "$WORK/classes" "$WORK/res" "$WORK/assets" "$OUT"

echo "▶ نسخ الواجهة"
cp -r "$PROJ/../web/." "$WORK/assets/web/"

echo "▶ حقن إعدادات البناء"
cat > "$WORK/assets/web/js/build-config.js" <<EOF
globalThis.WIFIHUB_BUILD = {
  configUrl: "${CFG_URL}",
  readToken: "${READ_TOKEN}",
  requestToken: "${REQ_TOKEN}"
};
EOF

echo "▶ موارد الواجهة"
mkdir -p "$WORK/res/values"
cat > "$WORK/res/values/strings.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<resources><string name="app_name">WiFi Hub</string></resources>
EOF

echo "▶ aapt2 compile + link"
"$BT/aapt2" compile --dir "$WORK/res" -o "$WORK/res.zip"
"$BT/aapt2" link -o "$WORK/base.apk" \
  -I "$PLATFORM" \
  --manifest "$PROJ/AndroidManifest.xml" \
  --min-sdk-version 24 --target-sdk-version 34 \
  -A "$WORK/assets" \
  "$WORK/res.zip"

echo "▶ javac"
javac -encoding UTF-8 -source 8 -target 8 -nowarn -bootclasspath "$PLATFORM" -classpath "$PLATFORM" \
  -d "$WORK/classes" "$PROJ/java/com/wifihub/app/MainActivity.java" 2>&1 | grep -v "^Note:" || true

echo "▶ d8"
"$BT/d8" --lib "$PLATFORM" --min-api 24 --output "$WORK" $(find "$WORK/classes" -name '*.class')

echo "▶ تجميع الحزمة"
cp "$WORK/base.apk" "$WORK/app-unsigned.apk"
(cd "$WORK" && zip -q -X app-unsigned.apk classes.dex)
"$BT/zipalign" -f 4 "$WORK/app-unsigned.apk" "$WORK/app-aligned.apk"

echo "▶ التوقيع"
KS="$PROJ/keystore/wifihub.keystore"
if [[ ! -f "$KS" ]]; then
  mkdir -p "$PROJ/keystore"
  keytool -genkeypair -v -keystore "$KS" -storepass wifihub -keypass wifihub \
    -alias wifihub -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=WiFi Hub, OU=App, O=WiFi Hub, L=, S=, C=" >/dev/null 2>&1
  echo "  أُنشئ مفتاح التوقيع: $KS (كلمة المرور: wifihub)"
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:wifihub --key-pass pass:wifihub \
  --out "$OUT/wifihub.apk" "$WORK/app-aligned.apk"
"$BT/apksigner" verify "$OUT/wifihub.apk" && echo "  ✔ التوقيع صالح"

echo "▶ تم: $OUT/wifihub.apk ($(du -h "$OUT/wifihub.apk" | cut -f1))"
