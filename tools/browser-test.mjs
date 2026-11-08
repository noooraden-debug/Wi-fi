#!/usr/bin/env node
/* فحص الواجهة في متصفح حقيقي (Chromium) مقابل راوتر وهمي */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WEB_PORT = 8899, MOCK_PORT = 8099;
const TMP = '/tmp/wifihub-webtest';

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.cpSync(path.join(ROOT, 'web'), TMP, { recursive: true });
fs.writeFileSync(path.join(TMP, 'hub.json'), JSON.stringify({
  app: { name: 'WiFi Hub', owner: 'Test', whatsapp: '966500000000', adminPass: 'admin', currency: 'ريال' },
  settings: { autoApprove: false, pollSeconds: 3600 },
  plans: [{ id: 'm1', label: 'شهري', days: 30, price: 100, maxDev: 3 }],
  router: { base: `http://127.0.0.1:${MOCK_PORT}`, username: 'root', password: 'testpass' },
  codes: [], subscribers: [], requests: []
}, null, 2));

const procs = [];
function start(cmd, args, cwd) {
  const p = spawn(cmd, args, { cwd, stdio: 'ignore', detached: false });
  procs.push(p); return p;
}
start('python3', ['-m', 'http.server', String(WEB_PORT), '--directory', TMP]);
start('node', ['tools/mock-ubus.mjs', String(MOCK_PORT)], ROOT);
await new Promise(r => setTimeout(r, 2000));

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? (pass++, console.log('  ✔ ' + n)) : (fail++, console.log('  ✘ ' + n + (e ? ' — ' + e : ''))); };

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${WEB_PORT}/index.html`);
ok('فتح الصفحة', await page.title() === 'WiFi Hub');

console.log('\n▶ إعداد رابط الإعدادات');
await page.fill('#cfgUrl', `http://127.0.0.1:${WEB_PORT}/hub.json`);
await page.click('text=تحميل الإعدادات');
await page.waitForTimeout(1500);
ok('الانتقال لشاشة الدخول', await page.isVisible('#loginBox'));
ok('لا أخطاء JS بعد التحميل', errors.length === 0, errors.join(' | '));

console.log('\n▶ إنشاء حساب مشترك');
await page.click('#tabReg');
await page.fill('#rUser', 'ahmad');
await page.fill('#rPass', '1234');
await page.fill('#rPass2', '1234');
await page.click('text=إنشاء الحساب');
await page.waitForTimeout(2500);
ok('دخول التطبيق', await page.isVisible('#appView'));

console.log('\n▶ الاتصال بالراوتر والأجهزة');
await page.waitForTimeout(2500);
const chip = await page.textContent('#netChip');
ok('حالة الاتصال بالراوتر', /متصل/.test(chip || ''), chip);
const rows = await page.$$('#tblDash tbody tr');
ok('عرض الأجهزة في اللوحة', rows.length >= 2, 'الصفوف=' + rows.length);

console.log('\n▶ قسم الأجهزة');
await page.click('#nav button[data-s="dev"]');
await page.waitForTimeout(800);
const devRows = await page.$$('#tblDev tbody tr');
ok('عرض قائمة الأجهزة', devRows.length >= 2, 'الصفوف=' + devRows.length);

console.log('\n▶ تغيير اسم الشبكة');
await page.click('#nav button[data-s="wifi"]');
await page.waitForTimeout(1200);
await page.fill('#wSsid', 'TestNetwork');
await page.fill('#wPass', 'strongpass123');
await page.click('text=حفظ وتطبيق');
await page.waitForTimeout(2000);
const toastText = await page.textContent('body');
ok('تنفيذ أمر تغيير الواي فاي', /تم الحفظ والتطبيق/.test(toastText), toastText.slice(0, 120));

console.log('\n▶ قسم الاشتراك');
await page.click('#nav button[data-s="sub"]');
await page.waitForTimeout(600);
ok('عرض الباقات', (await page.$$('#plansBox .pc')).length >= 1);

console.log('\n▶ لوحة الإدارة');
await page.evaluate(() => { document.querySelector('#authView').classList.add('hide'); });
await page.evaluate(() => { globalThis.showSection('admin'); });
await page.waitForTimeout(1200);
ok('فتح لوحة الإدارة', await page.isVisible('#secAdmin'));

console.log('\n▶ الأخطاء');
const realErrors = errors.filter(e => !/favicon|net::ERR_/.test(e));
ok('لا أخطاء JS', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

await browser.close();
for (const p of procs) { try { p.kill(); } catch (e) {} }
console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل\n`);
process.exit(fail ? 1 : 0);
