#!/usr/bin/env bash
# تجهيز مستودع GitHub الجاهز للرفع:
#   - hub.json في الجذر  →  رابط الإعدادات: https://raw.githubusercontent.com/<OWNER>/<REPO>/main/hub.json
#   - web/ + android/ + .github/workflows  →  GitHub Actions يبني الـ APK تلقائياً
#   - .github/scripts/activate.js  →  تفعيل الاشتراكات تلقائياً من طلبات التطبيق
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/github-repo"

rm -rf "$DEST"; mkdir -p "$DEST"

copy() { cp -r "$ROOT/$1" "$DEST/$2"; }

copy web            web
copy android        android
copy config         config
copy tools          tools
copy .github        .github
copy README.md      README.md

# ملف الإعدادات في جذر المستودع
cp "$ROOT/config/hub.json" "$DEST/hub.json"
cp "$ROOT/config/hub.schema.json" "$DEST/hub.schema.json"

# تنظيف ملفات البناء المحلية
rm -rf "$DEST/android/build" "$DEST/android/dist" "$DEST/android/keystore"
rm -f "$DEST/web/js/build-config.js.bak"

touch "$DEST/.nojekyll"

cat > "$DEST/.gitignore" <<'EOF'
android/build/
android/dist/
android/keystore/
node_modules/
.DS_Store
EOF

echo "✔ جاهز للرفع: $DEST"
echo "  hub.json          → ارفعه ثم عدّل router.password"
echo "  .github/workflows → بناء APK + تفعيل تلقائي للاشتراكات"
echo ""
echo "  الأوامر:"
echo "    cd github-repo && git init && git add -A && git commit -m 'WiFi Hub'"
echo "    git branch -M main && git remote add origin https://github.com/<OWNER>/<REPO>.git && git push -u origin main"
ls -la "$DEST"
