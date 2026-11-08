/* WiFi Hub — اختبار شامل للواجهة البرمجية وقاعدة البيانات
 * التشغيل:  node tools/api-test.mjs
 * يفتح خادماً على منفذ عشوائي، يختبر: التسجيل · الدخول · توليد الأكواد ·
 * التفعيل لمرة واحدة · اعتماد الطلب · المزامنة اللحظية (SSE) · قفل المميزات.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wifihub-test-'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✖', name, extra); }
};

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), WIFIHUB_DATA: TMP, WIFIHUB_DB: path.join(TMP, 'test.db') },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', d => process.stdout.write('    [srv] ' + d));
child.stderr.on('data', d => process.stdout.write('    [err] ' + d));

const wait = ms => new Promise(r => setTimeout(r, ms));

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { status: res.status, data: j };
}

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/public/config'); if (r.ok) return true; } catch (e) {}
    await wait(200);
  }
  return false;
}

(async () => {
  console.log('\n=== WiFi Hub — اختبار الخادم الداخلي ===\n');
  ok('الخادم يعمل', await waitServer());
  if (!ok) { child.kill(); process.exit(1); }

  /* ---------- 1) الإعدادات العلنية ---------- */
  console.log('\n[1] الإعدادات العلنية');
  const pub = await api('/api/public/config');
  ok('رقم واتساب صحيح', pub.data?.app?.whatsapp === '963957869853', JSON.stringify(pub.data?.app));
  ok('عدد الباقات = 4', (pub.data?.plans || []).length === 4);
  ok('اسم المستخدم الإداري = boss', pub.data?.adminUsername === 'boss');

  /* ---------- 2) دخول الإدارة بالبيانات الافتراضية ---------- */
  console.log('\n[2] دخول الإدارة');
  const badAdmin = await api('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'wrong' } });
  ok('كلمة مرور خاطئة تُرفض', badAdmin.status === 401);
  const admin = await api('/api/auth/login', { method: 'POST', body: { username: 'boss', password: '9876' } });
  ok('دخول boss/9876 ينجح', admin.status === 200 && !!admin.data.token, JSON.stringify(admin.data));
  const AT = admin.data.token;

  /* ---------- 3) تسجيل مشترك ---------- */
  console.log('\n[3] تسجيل مشترك جديد');
  const reg = await api('/api/auth/register', { method: 'POST', body: { username: 'ahmad', password: '1234' } });
  ok('إنشاء الحساب', reg.status === 200 && !!reg.data.token);
  const UT = reg.data.token;
  const dup = await api('/api/auth/register', { method: 'POST', body: { username: 'ahmad', password: '1234' } });
  ok('الاسم المحجوز يُرفض', dup.status === 409);

  const me0 = await api('/api/me', { token: UT });
  ok('الحالة الابتدائية = مجاني', me0.data?.user?.status === 'free');
  ok('لا تُرسل بيانات الراوتر لمجاني', me0.data?.user?.router === null);
  ok('عدد الأيام = 0', me0.data?.user?.daysLeft === 0);

  /* ---------- 4) توليد أكواد ---------- */
  console.log('\n[4] توليد الأكواد');
  const gen = await api('/api/admin/codes', { method: 'POST', token: AT, body: { qty: 3, plan: 'm12', maxDev: 7 } });
  ok('توليد 3 أكواد', gen.data?.codes?.length === 3);
  const code = gen.data.codes[0];
  ok('صيغة الكود صحيحة', /^WH-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(code), code);
  ok('الأكواد مختلفة', new Set(gen.data.codes).size === 3);

  /* ---------- 5) التفعيل لمرة واحدة ---------- */
  console.log('\n[5] تفعيل الكود');
  const badCode = await api('/api/redeem', { method: 'POST', token: UT, body: { code: 'WH-XXXXX-XXXXX-XXXXX-XXXXX' } });
  ok('كود غير موجود يُرفض', badCode.status === 404);
  const red = await api('/api/redeem', { method: 'POST', token: UT, body: { code } });
  ok('تفعيل الكود ينجح', red.status === 200, JSON.stringify(red.data));
  ok('المشترك أصبح بريميوم', red.data?.user?.status === 'premium');
  ok('عدد الأيام = 365', red.data?.user?.daysLeft === 365);
  ok('بيانات الراوتر تُرسل للبريميوم', !!red.data?.user?.router);
  const reuse = await api('/api/redeem', { method: 'POST', token: UT, body: { code } });
  ok('إعادة استخدام الكود مرفوضة', reuse.status === 409, JSON.stringify(reuse.data));

  /* ---------- 6) حالة الكود في لوحة الإدارة ---------- */
  console.log('\n[6] لوحة الإدارة');
  const ov = await api('/api/admin/overview', { token: AT });
  ok('لوحة الإدارة تعمل', ov.status === 200);
  ok('عدّاد بريميوم = 1', ov.data?.stats?.premium === 1);
  ok('عدّاد مجاني = 0', ov.data?.stats?.free === 0);
  ok('الكود مستخدم في اللوحة', (ov.data?.codes || []).find(c => c.code === code)?.usedBy === 'ahmad');
  ok('المشترك في القائمة', (ov.data?.subscribers || []).some(s => s.username === 'ahmad'));

  /* ---------- 7) طلب باقة + موافقة الإدارة + مزامنة لحظية ---------- */
  console.log('\n[7] الطلب والموافقة والمزامنة اللحظية');
  const reg2 = await api('/api/auth/register', { method: 'POST', body: { username: 'sara', password: '1234' } });
  const ST = reg2.data.token;

  /* نسمع على القناة اللحظية قبل الموافقة */
  const events = [];
  const controller = new AbortController();
  const streamDone = (async () => {
    try {
      const res = await fetch(`${BASE}/api/stream?token=${encodeURIComponent(ST)}`, { signal: controller.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const p of parts) {
          const line = p.split('\n').find(l => l.startsWith('data: '));
          if (line) { try { events.push(JSON.parse(line.slice(6))); } catch (e) {} }
        }
      }
    } catch (e) {}
  })();

  await wait(400);
  const req = await api('/api/request', { method: 'POST', token: ST, body: { plan: 'm3' } });
  ok('تسجيل طلب الباقة', req.status === 200);
  await wait(300);
  const ov2 = await api('/api/admin/overview', { token: AT });
  const pending = (ov2.data?.requests || []).find(r => r.username === 'sara' && r.status === 'pending');
  ok('الطلب يظهر للمدير', !!pending);
  const appr = await api(`/api/admin/requests/${pending.id}/approve`, { method: 'POST', token: AT, body: {} });
  ok('موافقة الإدارة', appr.status === 200);
  await wait(600);
  ok('حدث لحظي وصل للمشترك', events.some(e => e.type === 'subscription.activated'), JSON.stringify(events));
  const me2 = await api('/api/me', { token: ST });
  ok('المشترك صار بريميوم', me2.data?.user?.status === 'premium');
  ok('المتبقي 90 يوم', me2.data?.user?.daysLeft === 90);
  controller.abort();

  /* ---------- 8) خادم الإعدادات ---------- */
  console.log('\n[8] الإعدادات والراوتر');
  const setR = await api('/api/admin/settings', { method: 'POST', token: AT, body: { router: { base: 'http://192.168.1.1', username: 'root', password: 'secret' }, app: { whatsapp: '963957869853' } } });
  ok('حفظ إعدادات الراوتر', setR.status === 200);
  const me3 = await api('/api/me', { token: UT });
  ok('البيانات الجديدة وصلت للمشترك', me3.data?.user?.router?.base === 'http://192.168.1.1');
  const sync = await api('/api/me/router-password', { method: 'POST', token: UT, body: { password: 'newpass123' } });
  ok('مزامنة كلمة مرور الراوتر', sync.status === 200);

  /* ---------- 9) الصلاحيات ---------- */
  console.log('\n[9] الصلاحيات');
  const noAdmin = await api('/api/admin/overview', { token: UT });
  ok('المشترك لا يدخل لوحة الإدارة', noAdmin.status === 403);
  const noAuth = await api('/api/admin/overview');
  ok('بلا جلسة = 401', noAuth.status === 401);
  const freeRouter = await api('/api/me/router-password', { method: 'POST', token: (await api('/api/auth/register', { method: 'POST', body: { username: 'omar', password: '1234' } })).data.token, body: { password: 'hacked' } });
  ok('المستخدم المجاني لا يغيّر كلمة مرور الراوتر', freeRouter.status === 403);

  console.log(`\n=== النتيجة: ${pass} ناجح · ${fail} فاشل ===\n`);
  child.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
