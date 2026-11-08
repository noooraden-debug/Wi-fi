#!/usr/bin/env node
/* اختبار ذاتي للمحرك مقابل راوتر وهمي */
import { Router } from '../web/js/router.js';

const BASE = process.env.MOCK_BASE || 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? ' — ' + extra : '')); }
};

const r = new Router({ base: BASE, username: 'root', password: 'testpass' });

console.log('\n▶ الاتصال وتسجيل الدخول');
try {
  const b = await r.connect();
  ok('اتصال بالراوتر (' + b + ')', b === BASE);
} catch (e) { ok('اتصال بالراوتر', false, e.message); process.exit(1); }

console.log('\n▶ بيانات اللوحة');
const board = await r.board();
ok('قراءة معلومات اللوح', !!board.model, JSON.stringify(board));

console.log('\n▶ قائمة الأجهزة');
const devs = await r.clients();
ok('عدد الأجهزة ≥ 2', devs.length >= 2, 'العدد=' + devs.length);
const phone = devs.find(d => d.mac.includes('a4:83:e7'));
ok('استخراج IP من سجل DHCP', !!phone && phone.ip === '192.168.1.31', JSON.stringify(phone));
ok('استهلاك الجهاز محسوب', phone && phone.usage > 0);
ok('تمييز نوع الجهاز (هاتف)', phone && phone.type === 'phone', phone && phone.type);

console.log('\n▶ إعدادات الواي فاي');
const st = await r.wifiState();
ok('قراءة اسم الشبكة', st.ssid === 'MyHomeWiFi', st.ssid);
ok('قراءة نوع التشفير', st.encryption === 'psk2', st.encryption);
ok('عدد واجهات الواي فاي ≥ 2', st.ifaces.length >= 2, String(st.ifaces.length));

console.log('\n▶ تغيير الواي فاي');
await r.wifiSet({ ssid: 'NewWiFi', password: 'strongpass123', band: 'both' });
const st2 = await r.wifiState();
ok('تطبيق اسم الشبكة الجديد', st2.ssid === 'NewWiFi', st2.ssid);

console.log('\n▶ حظر جهاز (قاعدة فايروول + تثبيت IP)');
await r.blockDevice(phone.mac, phone.ip);
const ub = await r.ubus.call('uci', 'get', { config: 'firewall' });
const keys = Object.keys(ub.values || {});
ok('إنشاء قاعدة حظر في UCI', keys.some(k => /hubblk/i.test(k)), keys.join(','));
const dh = await r.ubus.call('uci', 'get', { config: 'dhcp' });
ok('تثبيت عنوان IP للجهاز', Object.keys(dh.values || {}).some(k => /hubpin/i.test(k)));

console.log('\n▶ رفع الحظر');
await r.unblockDevice(phone.mac);
const ub2 = await r.ubus.call('uci', 'get', { config: 'firewall' });
ok('حذف قاعدة الحظر', !Object.keys(ub2.values || {}).some(k => /hubblk/i.test(k)));

console.log('\n▶ إعادة تسمية جهاز');
await r.renameDevice(phone.mac, 'MyPhone');
const dh2 = await r.ubus.call('uci', 'get', { config: 'dhcp' });
ok('حفظ الاسم الجديد', Object.values(dh2.values || {}).some(v => v && v.name === 'MyPhone'));

console.log('\n▶ تغيير كلمة مرور الراوتر والتحقق منها');
try {
  const rr = await r.setAdminPassword('newpass123', 'root');
  ok('تغيير كلمة المرور', rr.ok === true && rr.verified === true);
  const r2 = new Router({ base: BASE, username: 'root', password: 'newpass123' });
  let okLogin = false;
  try { await r2.connect(); okLogin = true; } catch (e) {}
  ok('الدخول بكلمة المرور الجديدة', okLogin);
} catch (e) { ok('تغيير كلمة المرور', false, e.message); }

console.log('\n▶ بيانات خاطئة');
const bad = new Router({ base: BASE, username: 'root', password: 'wrong' });
let failed = false;
try { await bad.connect(); } catch (e) { failed = true; }
ok('رفض كلمة المرور الخاطئة', failed);

console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل\n`);
process.exit(fail ? 1 : 0);
