#!/usr/bin/env node
/* تسجيل طلب اشتراك من Issue داخل hub.json — يعمل داخل GitHub Actions.
 * لا يوجد اشتراك تلقائي: الطلب يُحفظ في قائمة requests ليظهر للمالك في لوحة الإدارة،
 * والتفعيل يكون بضغطة «تفعيل» من لوحة الإدارة (أو آلياً فقط إذا settings.autoApprove = true).
 */
const fs = require('fs');

const FILE = 'hub.json';
const raw = process.env.ISSUE_BODY || '{}';
let req = {};
try { req = JSON.parse(raw); } catch (e) { req = { username: '', plan: '' }; }

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
data.requests = data.requests || [];
data.subscribers = data.subscribers || [];
data.codes = data.codes || [];

const username = String(req.username || '').trim();
const now = Date.now();
const plans = data.plans || [];
const planOf = id => plans.find(p => p.id === id);

let activated = false, reason = '';

/* طلب تغيير كلمة مرور الراوتر من داخل التطبيق — يحدّث hub.json تلقائياً */
if (req.kind === 'router-password' && req.newPassword) {
  data.router = Object.assign({}, data.router, { password: String(req.newPassword) });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  console.log('result=router-password-updated');
  process.exit(0);
}

/* تسجيل مستخدم مجاني جديد (يظهر للمالك بحالة «مجاني») */
if (req.kind === 'register' && username) {
  data.users = data.users || [];
  if (!data.users.find(u => u.username === username)) {
    data.users.push({ username, at: now, status: 'free', plan: '' });
  }
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  console.log('username=' + username + ' result=registered-free');
  process.exit(0);
}

if (username) {
  const code = String(req.code || '').trim().toUpperCase();
  const c = code ? data.codes.find(x => String(x.code).toUpperCase() === code) : null;
  const plan = planOf(req.plan) || (c ? planOf(c.plan) : null);

  /* تفعيل كود صحيح: تحويل المشترك إلى بريميوم مركزياً + وسم الكود كمستخدم */
  if ((req.kind === 'redeem' || req.kind === 'activate') && c && !c.usedBy && (!c.expiresAt || c.expiresAt > now)) {
    const cp = planOf(c.plan);
    if (cp) {
      const rec = data.subscribers.find(s => s.username === username) || {
        id: 'u' + now.toString(36), username, devices: [], created: now
      };
      rec.plan = cp.id;
      rec.start = now;
      rec.end = now + cp.days * 864e5;
      rec.maxDev = c.maxDev || cp.maxDev;
      if (!data.subscribers.includes(rec)) data.subscribers.push(rec);
      c.usedBy = username; c.usedAt = now;
      for (const r of (data.requests || [])) if (r.username === username && r.code === c.code) r.status = 'approved';
      activated = true; reason = 'redeemed';
    }
  }

  /* التفعيل التلقائي معطّل افتراضياً: المالك هو من يعتمد الاشتراك.
     يُفعَّل فقط إذا طلب المالك ذلك صراحةً من الإعدادات (autoApprove). */
  if ((data.settings && data.settings.autoApprove) && plan) {
    const rec = data.subscribers.find(s => s.username === username) || {
      id: 'u' + now.toString(36), username, devices: [], created: now
    };
    rec.plan = plan.id;
    rec.start = now;
    rec.end = now + plan.days * 864e5;
    rec.maxDev = plan.maxDev;
    if (!data.subscribers.includes(rec)) data.subscribers.push(rec);
    if (c) { c.usedBy = username; c.usedAt = now; }
    activated = true; reason = 'auto-approved';
  } else {
    /* تسجيل الطلب فقط — بانتظار موافقة المالك من لوحة الإدارة */
    data.requests.unshift({
      id: 'rq' + now.toString(36),
      username, plan: plan ? plan.id : (req.plan || ''), code: code || '',
      phone: req.phone || '', at: now, status: 'pending'
    });
    reason = 'pending-approval';
  }
}

fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
console.log('username=' + username + ' result=' + (reason || 'ignored') + ' activated=' + activated);
