#!/usr/bin/env python3
"""فحص شامل للواجهة في متصفح حقيقي (Chromium) مقابل راوتر وهمي:
   المستخدم المجاني · المستخدم البريميوم · لوحة الإدارة."""
import json, os, shutil, subprocess, sys, time, hashlib, secrets
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WEB_PORT, MOCK_PORT = 8899, 8099
TMP = Path("/tmp/wifihub-webtest")

# ── بيانات دخول الإدارة (مُشفَّرة مثل hub.json) ─────────────────────────
SALT = secrets.token_hex(16)
ADMIN_HASH = hashlib.sha256((SALT + ":admin").encode()).hexdigest()
NOW = int(time.time() * 1000)
DAY = 86400000

if TMP.exists():
    shutil.rmtree(TMP)
TMP.mkdir(parents=True)
shutil.copytree(ROOT / "web", TMP, dirs_exist_ok=True)
(TMP / "hub.json").write_text(json.dumps({
    "app": {
        "name": "WiFi Hub", "owner": "Test", "whatsapp": "963957869853",
        "admin": {"username": "admin", "salt": SALT, "hash": ADMIN_HASH},
        "currency": "ريال"
    },
    "settings": {"autoApprove": False, "pollSeconds": 3600},
    "plans": [
        {"id": "m1", "label": "شهري", "days": 30, "price": 100, "maxDev": 3},
        {"id": "m3", "label": "3 أشهر", "days": 90, "price": 250, "maxDev": 5},
        {"id": "m6", "label": "6 أشهر", "days": 180, "price": 450, "maxDev": 10},
        {"id": "m12", "label": "سنة", "days": 365, "price": 700, "maxDev": 15}
    ],
    "router": {"base": f"http://127.0.0.1:{MOCK_PORT}", "username": "root", "password": "testpass"},
    "codes": [
        {"code": "WH-TEST1-CODE", "plan": "m1", "maxDev": 3, "created": NOW, "expiresAt": 0,
         "usedBy": "sara", "usedAt": NOW},
        {"code": "WH-ABCD2-EFG34-HIJ56-KLM78", "plan": "m12", "maxDev": 15, "created": NOW,
         "expiresAt": 0, "usedBy": "", "usedAt": 0}
    ],
    "subscribers": [
        {"id": "u1", "username": "sara", "plan": "m1", "start": NOW - 5 * DAY, "end": NOW + 25 * DAY,
         "maxDev": 3, "devices": [{"mac": "a4:83:e7:21:9b:10", "name": "Galaxy"}]},
        {"id": "u2", "username": "expired", "plan": "m1", "start": NOW - 40 * DAY, "end": NOW - 10 * DAY,
         "maxDev": 3, "devices": []}
    ],
    "users": [{"username": "ayesha", "at": NOW - 7200 * 1000, "status": "free", "plan": ""}],
    "requests": [
        {"id": "rq1", "username": "omar", "plan": "m3", "code": "", "at": NOW - 3600 * 1000, "status": "pending"}
    ]
}, ensure_ascii=False, indent=2))

procs = [
    subprocess.Popen(["python3", "-m", "http.server", str(WEB_PORT), "--directory", str(TMP)],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
    subprocess.Popen(["node", "tools/mock-ubus.mjs", str(MOCK_PORT)], cwd=ROOT,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
]
time.sleep(2)

passed, failed = 0, 0
def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1; print("  ✔", name)
    else:
        failed += 1; print("  ✘", name, ("— " + str(extra)) if extra else "")

def setup(page):
    page.goto(f"http://127.0.0.1:{WEB_PORT}/index.html")
    page.fill("#cfgUrl", f"http://127.0.0.1:{WEB_PORT}/hub.json")
    page.click("text=تحميل الإعدادات")
    page.wait_for_timeout(1200)

def register(page, user):
    page.click("#tabReg")
    page.fill("#rUser", user)
    page.fill("#rPass", "1234")
    page.fill("#rPass2", "1234")
    page.click("text=إنشاء الحساب")
    page.wait_for_timeout(2500)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ═══ 1) المستخدم المجاني ═══
        print("\n▶ المستخدم المجاني (بدون اشتراك)")
        ctx = browser.new_context(); page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: (errs.append(str(e)), print("   [pageerror]", str(e)[:200])))
        setup(page)
        register(page, "omar")
        ok("دخول المستخدم المجاني", page.is_visible("#appView"))
        dash = page.text_content("#dashStats") or ""
        ok("تصنيفه مجاني في اللوحة", "مجاني" in dash, dash[:80])
        page.click("#nav button[data-s='dev']"); page.wait_for_timeout(700)
        devtxt = page.text_content("#tblDev") or ""
        ok("الأجهزة مقفلة للمجاني", "مقفل" in devtxt or "مقفلة" in devtxt, devtxt[:80])
        page.click("#nav button[data-s='wifi']"); page.wait_for_timeout(700)
        wifitxt = page.text_content("#secWifi") or ""
        ok("تغيير كلمة الواي فاي مقفل للمجاني", "مقفلة" in wifitxt and "مقفل" not in page.text_content("#wifiForm"), wifitxt[:60])
        ok("لا أخطاء JS (مجاني)", not errs, " | ".join(errs[:2]))

        # رسالة الواتساب (الرقم + اسم الباقة)
        page.click("#nav button[data-s='sub']"); page.wait_for_timeout(600)
        page.click("#plansBox button.wa"); page.wait_for_timeout(2500)
        pop = ctx.pages[-1] if len(ctx.pages) > 1 else None
        wa = pop.url if pop else ""
        ok("فتح واتساب على الرقم 963957869853", "963957869853" in wa, repr(wa)[:160])
        import urllib.parse as _up
        msg = _up.unquote(_up.parse_qs(_up.urlparse(wa).query).get("text", [""])[0])
        ok("الرسالة مميزة وتذكر الباقة", ("طلب اشتراك" in msg) and ("الباقة" in msg) and ("شهري" in msg), repr(msg)[:200])
        ok("الرسالة تحتوي اسم المستخدم", "omar" in msg, repr(msg)[:200])

        # تفعيل كود صحيح → بريميوم فوراً
        page.evaluate("globalThis.openRedeem()"); page.wait_for_timeout(400)
        page.fill("#rdCode", "WH-ABCD2-EFG34-HIJ56-KLM78")
        page.click("#btnRedeem"); page.wait_for_timeout(4000)
        errtxt = page.text_content("#rdErr") or ""
        if errtxt.strip():
            print("   [!] خطأ في التفعيل:", errtxt.strip())
        dash = page.text_content("#dashStats") or ""
        ok("الكود الصحيح يحوّل إلى بريميوم (عداد أيام)", "المتبقي" in dash, dash[:120])
        ok("باقة السنة = 365 يوم", "365" in dash, dash[:120])
        page.click("#nav button[data-s='dev']"); page.wait_for_timeout(1200)
        ok("الأجهزة تُفتح بعد التفعيل", len(page.query_selector_all("#tblDev tbody tr")) >= 2)
        ctx.close()

        # ═══ 1ب) مشترك منتهي الباقة → مجاني ومقفل ═══
        print("\n▶ مشترك انتهت باقته (يجب أن يعود مجانياً)")
        ctx = browser.new_context(); page = ctx.new_page()
        setup(page)
        register(page, "expired")
        page.wait_for_timeout(1500)
        dash = page.text_content("#dashStats") or ""
        ok("يظهر كمستخدم مجاني", "مجاني" in dash, dash[:100])
        banner = page.text_content("#subBanner") or ""
        ok("لافتة انتهاء الباقة", "انتهت باقتك" in banner, banner[:100])
        page.click("#nav button[data-s='dev']"); page.wait_for_timeout(700)
        ok("الأجهزة مقفلة بعد الانتهاء", "مقفل" in (page.text_content("#tblDev") or ""))
        page.click("#nav button[data-s='wifi']"); page.wait_for_timeout(700)
        ok("تغيير الواي فاي مقفل بعد الانتهاء", "مقفلة" in (page.text_content("#secWifi") or ""))
        ctx.close()

        # ═══ 2) المستخدم البريميوم ═══
        print("\n▶ المستخدم البريميوم (اشتراك مفعّل)")
        ctx = browser.new_context(); page = ctx.new_page()
        errs2 = []
        page.on("pageerror", lambda e: errs2.append(str(e)))
        setup(page)
        register(page, "sara")
        dash = page.text_content("#dashStats") or ""
        ok("عداد الأيام المتبقية يظهر", "المتبقي" in dash, dash[:120])
        ok("رقم الأيام المتبقي صحيح (25)", "25" in dash, dash[:120])
        page.click("#nav button[data-s='dev']"); page.wait_for_timeout(1200)
        devrows = page.query_selector_all("#tblDev tbody tr")
        ok("الأجهزة مفتوحة للبريميوم", len(devrows) >= 2, "الصفوف=" + str(len(devrows)))
        page.click("#nav button[data-s='wifi']"); page.wait_for_timeout(900)
        ok("نموذج تغيير الواي فاي مفتوح", page.is_visible("#wifiForm"))
        page.fill("#wSsid", "TestNetwork"); page.fill("#wPass", "strongpass123")
        page.click("#secWifi button.p"); page.wait_for_timeout(2200)
        ok("تنفيذ تغيير الواي فاي", "تم الحفظ والتطبيق" in (page.text_content("body") or ""))
        page.click("#nav button[data-s='sub']"); page.wait_for_timeout(700)
        subtxt = page.text_content("#mySub") or ""
        ok("صفحة الاشتراك تعرض الباقة والمتبقي", "مفعّل" in subtxt and "يوم" in subtxt, subtxt[:100])
        ok("لا أخطاء JS (بريميوم)", not errs2, " | ".join(errs2[:2]))
        ctx.close()

        # ═══ 3) لوحة الإدارة ═══
        print("\n▶ لوحة الإدارة (دخول بكلمة مرور مُشفَّرة)")
        ctx = browser.new_context(); page = ctx.new_page()
        errs3 = []
        page.on("pageerror", lambda e: errs3.append(str(e)))
        setup(page)
        page.click("#tabAdmin")
        page.fill("#aUser", "admin"); page.fill("#aPass", "wrongpass")
        page.click("text=دخول لوحة الإدارة"); page.wait_for_timeout(800)
        ok("رفض كلمة المرور الخاطئة", page.is_visible("#aErr"))
        page.fill("#aUser", "admin"); page.fill("#aPass", "admin")
        page.click("text=دخول لوحة الإدارة"); page.wait_for_timeout(2000)
        ok("قبول بيانات الإدارة الصحيحة", page.is_visible("#appView"))
        ok("اسم المدير يظهر في الأعلى", "مدير" in (page.text_content("#whoName") or "") and "الإدارة" in (page.text_content("#whoRole") or ""))
        page.evaluate("globalThis.showSection('admin')"); page.wait_for_timeout(1200)
        subs = page.text_content("#tblSubs") or ""
        ok("جدول المشتركين يعرض بريميوم", "بريميوم" in subs, subs[:100])
        ok("جدول المشتركين يعرض الأيام المتبقية", "25 يوم" in subs, subs[:160])
        ok("جدول المشتركين يعرض الكود المستخدم", "WH-TEST1-CODE" in subs, subs[:200])
        free = page.text_content("#tblFree") or ""
        ok("جدول المجانيين/الطلبات يعرض omar", "omar" in free, free[:100])
        ok("المستخدم المجاني المسجَّل يظهر في جدول المشتركين", "ayesha" in subs and "مجاني" in subs, subs[:200])
        ok("حالة المجاني مكتوبة «مجاني»", "مجاني" in free, free[:120])
        # توليد أكواد قوية ومتنوعة
        page.select_option("#codePlan", "m12")
        page.fill("#codeQty", "5")
        page.click("text=⚡ توليد"); page.wait_for_timeout(2500)
        newcodes = [c for c in page.evaluate("document.querySelector('#newCodes').dataset.codes || ''").split(",") if c]
        ok("تم توليد 5 أكواد", len(newcodes) == 5, str(len(newcodes)))
        import re as _re
        pat = _re.compile(r"^WH-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$")
        ok("صيغة الأكواد قوية (25 خانة)", all(pat.match(c) for c in newcodes), str(newcodes[:1]))
        ok("الأكواد غير مكررة", len(set(newcodes)) == len(newcodes))
        ok("لا أخطاء JS (إدارة)", not errs3, " | ".join(errs3[:2]))
        ctx.close()

        browser.close()
finally:
    for pr in procs:
        try: pr.terminate()
        except Exception: pass

print(f"\nالنتيجة: {passed} ناجح / {failed} فاشل\n")
sys.exit(1 if failed else 0)
