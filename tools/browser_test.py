#!/usr/bin/env python3
"""فحص شامل للواجهة في متصفح حقيقي (Chromium) مقابل الخادم الداخلي وراوتر وهمي:
   لوحة الدخول · تذكّرني · قفل المميزات للمجاني · تفعيل الكود · لوحة الإدارة ·
   المزامنة اللحظية بين الإدارة والمشترك."""
import json, os, shutil, subprocess, sys, time, re
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SERVER_PORT, MOCK_PORT = 8899, 8099
BASE = f"http://127.0.0.1:{SERVER_PORT}"
TMP = Path("/tmp/wifihub-webtest2")
CHROME = os.environ.get("CHROME_PATH", "/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome")

PASS, FAIL = 0, 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1; print("  ✔", name)
    else:
        FAIL += 1; print("  ✖", name, extra)

if TMP.exists():
    shutil.rmtree(TMP)
TMP.mkdir(parents=True)

# ── تنظيف أي عمليات قديمة على نفس المنافذ ─────────────────────────────
subprocess.run("pkill -9 -f 'tools/mock-ubus.mjs' ; pkill -9 -f 'server/server.js'",
               shell=True, check=False)
time.sleep(0.8)

# ── تشغيل الراوتر الوهمي والخادم الداخلي ────────────────────────────────
mock = subprocess.Popen(["node", str(ROOT / "tools/mock-ubus.mjs"), str(MOCK_PORT)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
server = subprocess.Popen(["node", str(ROOT / "server/server.js")],
                          env={**os.environ, "PORT": str(SERVER_PORT),
                               "WIFIHUB_DATA": str(TMP), "WIFIHUB_DB": str(TMP / "web.db")},
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2.5)

def api(path, method="GET", body=None, token=None):
    import urllib.request
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": "Bearer " + token} if token else {})})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())

try:
    admin = api("/api/auth/login", "POST", {"username": "boss", "password": "9876"})
    AT = admin["token"]
    api("/api/admin/settings", "POST", token=AT, body={
        "router": {"base": f"http://127.0.0.1:{MOCK_PORT}", "username": "root", "password": "testpass"}})

    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 430, "height": 900})
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        print("\n[1] لوحة تسجيل الدخول")
        page.goto(BASE, wait_until="networkidle")
        ok("لوحة الدخول ظاهرة", page.is_visible("#loginBox"))
        ok("زر تذكّرني موجود", page.is_visible("#lRemember"))
        ok("تبويب المدير موجود", page.is_visible("#tabAdmin"))
        page.click("#tabAdmin")
        ok("حقل اسم المدير معبّأ بـ boss", page.input_value("#aUser") == "boss")

        print("\n[2] تسجيل مشترك مجاني")
        page.click("#tabReg")
        page.fill("#rUser", "ahmad")
        page.fill("#rPass", "1234")
        page.fill("#rPass2", "1234")
        page.click("button:has-text('إنشاء الحساب')")
        page.wait_for_selector("#appView:not(.hide)", timeout=10000)
        ok("دخل التطبيق بعد التسجيل", page.is_visible("#appView"))
        ok("دور المستخدم = مشترك", "مشترك" in page.inner_text("#whoRole"))
        page.click("#nav button:has-text('الأجهزة')")
        page.wait_for_timeout(500)
        ok("الأجهزة مقفلة للمجاني", "مقفل" in page.inner_text("#tblDev"))
        page.click("#nav button:has-text('الواي فاي')")
        page.wait_for_timeout(500)
        ok("كلمة مرور الواي فاي مقفلة", "مقفلة" in page.inner_text("#wifiLocked"))
        page.click("#nav button:has-text('اشتراكي')")
        page.wait_for_timeout(400)
        ok("يظهر زر واتساب", page.is_visible("button:has-text('اطلب كود الباقة')"))
        ok("الباقات معروضة", page.inner_text("#plansBox").strip() != "")

        print("\n[3] لوحة الإدارة + توليد كود")
        actx = browser.new_context(viewport={"width": 430, "height": 900})
        adm = actx.new_page()
        adm.on("pageerror", lambda e: errors.append("admin:" + str(e)))
        adm.goto(BASE, wait_until="networkidle")
        adm.click("#tabAdmin")
        adm.fill("#aPass", "9876")
        adm.click("button:has-text('دخول لوحة الإدارة')")
        adm.wait_for_selector("#appView:not(.hide)", timeout=10000)
        ok("دخول الإدارة بـ boss/9876", "لوحة الإدارة" in adm.inner_text("#whoRole"))
        adm.click("#nav button:has-text('الإدارة')")
        adm.wait_for_timeout(800)
        ok("عدّاد المشتركين ظاهر", "المشتركون" in adm.inner_text("#admStats"))
        adm.fill("#codeQty", "2")
        adm.click("button:has-text('توليد')")
        adm.wait_for_timeout(1200)
        codes = re.findall(r"WH-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}", adm.inner_text("#newCodes"))
        ok("توليد كودين", len(codes) >= 2, str(codes))
        ok("الكود يظهر في جدول الأكواد", codes[0] in adm.inner_text("#tblCodes") if codes else False)
        adm.wait_for_timeout(500)
        ok("المشترك أahmad ظاهر في اللوحة", "ahmad" in adm.inner_text("#tblSubs"))

        print("\n[4] تفعيل الكود للمشترك")
        code = codes[0]
        page.click("#nav button:has-text('اشتراكي')")
        page.wait_for_timeout(400)
        page.click("button:has-text('أدخل كوداً')")
        page.wait_for_timeout(300)
        page.fill("#rdCode", code)
        page.click("#btnRedeem")
        page.wait_for_timeout(1500)
        ok("تحوّل لبريميوم", "بريميوم" in page.inner_text("#mySub"))
        ok("عداد الأيام يظهر", "يوم" in page.inner_text("#mySub"))
        page.click("#nav button:has-text('الأجهزة')")
        page.wait_for_timeout(2500)
        ok("الأجهزة مفتوحة بعد التفعيل", "مقفل" not in page.inner_text("#tblDev"))
        ok("جدول الأجهزة يعرض عناصر", page.locator("#tblDev tbody tr").count() >= 1)
        page.click("#nav button:has-text('الواي فاي')")
        page.wait_for_timeout(1200)
        ok("نموذج الواي فاي مفتوح", page.is_visible("#wSsid"))

        print("\n[5] المزامنة اللحظية (إدارة ⇄ مشترك)")
        sctx = browser.new_context(viewport={"width": 430, "height": 900})
        sara = sctx.new_page()
        sara.goto(BASE, wait_until="networkidle")
        sara.click("#tabReg")
        sara.fill("#rUser", "sara")
        sara.fill("#rPass", "1234")
        sara.fill("#rPass2", "1234")
        sara.click("button:has-text('إنشاء الحساب')")
        sara.wait_for_selector("#appView:not(.hide)", timeout=10000)
        sara.click("#nav button:has-text('اشتراكي')")
        sara.wait_for_timeout(400)
        sara.click("button:has-text('اطلب هذه الباقة')")   # يسجّل طلباً + يفتح واتساب
        sara.wait_for_timeout(1200)
        adm.wait_for_timeout(800)
        ok("الطلب ظهر للمدير لحظياً", "sara" in adm.inner_text("#tblFree"))
        # الموافقة من لوحة الإدارة
        adm.click("#tblFree button:has-text('تفعيل')")
        adm.wait_for_timeout(2000)
        sara.wait_for_timeout(1500)
        ok("المشترك تحوّل لبريميوم دون إعادة تحميل", "بريميوم" in sara.inner_text("#mySub"))

        print("\n[6] تذكّرني")
        adm2 = actx.new_page()
        adm2.goto(BASE, wait_until="networkidle")
        adm2.wait_for_timeout(1500)
        ok("جلسة الإدارة محفوظة بعد إعادة التحميل (تذكّرني)", adm2.is_visible("#appView"))

        print("\n[7] أخطاء جافاسكربت")
        real = [e for e in errors if "favicon" not in e.lower() and "net::ERR" not in e]
        ok("لا أخطاء JavaScript", len(real) == 0, str(real[:3]))

        page.screenshot(path="/tmp/wifihub-user.png", full_page=False)
        adm.screenshot(path="/tmp/wifihub-admin.png", full_page=False)
        browser.close()
finally:
    server.terminate(); mock.terminate()

print(f"\n=== نتيجة فحص المتصفح: {PASS} ناجح · {FAIL} فاشل ===")
sys.exit(1 if FAIL else 0)
