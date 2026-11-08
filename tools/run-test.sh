#!/usr/bin/env bash
# تشغيل الاختبار الذاتي مقابل راوتر وهمي (منفصل عن أي عملية أخرى)
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-8099}"
PIDF="/tmp/wifihub-mock.pid"

if [[ -f "$PIDF" ]]; then kill "$(cat "$PIDF")" 2>/dev/null || true; rm -f "$PIDF"; fi
sleep 0.5

setsid node tools/mock-ubus.mjs "$PORT" >/tmp/wifihub-mock.log 2>&1 &
echo $! > "$PIDF"
sleep 1.5

MOCK_BASE="http://127.0.0.1:$PORT" node tools/selftest.mjs
RC=$?
kill "$(cat "$PIDF")" 2>/dev/null || true
exit $RC
