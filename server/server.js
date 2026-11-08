/* WiFi Hub — الخادم الداخلي (قاعدة بيانات + واجهة برمجية + مزامنة لحظية)
 *
 * التشغيل:  node server/server.js   (أو npm start)
 * كل شيء محلي: قاعدة SQLite في data/wifihub.db — لا GitHub ولا خدمة خارجية.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  db, findUser, listUsers, createUser, updateUser, findCode, listCodes, insertCode,
  listRequests, findRequest, createRequest, updateRequest, logEvent, recentEvents,
  getSetting, setSetting, getJSON, setJSON, getPlans, getRouterCfg, getAppCfg,
  isPremiumUser, daysLeftOf, DEFAULT_PLANS
} from './db.js';
import {
  hashPassword, verifyPassword, issueSession, sessionUser, revokeSession,
  ensureAdmin, adminCredentials, changeAdminCredentials, checkAdmin, generateCode, planById
} from './auth.js';
import { addClient, removeClient, broadcast, toUser, startHeartbeat, clientCount } from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

/* ===================== أدوات مساعدة ===================== */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8'
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error('حجم الطلب كبير جداً');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function tokenOf(req, url) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return url.searchParams.get('token') || '';
}

function clientInfo(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? String(forwarded).split(',') : req.socket.remoteAddress;
  return String(ip || '').trim();
}

/* ===================== الإقلاع ===================== */
const seeded = ensureAdmin();
if (!getSetting('app', null)) setJSON('app', { name: 'WiFi Hub', owner: 'المالك', whatsapp: '963957869853', currency: 'ريال' });
if (!getSetting('router', null)) setJSON('router', { base: '', username: 'root', password: '', wifiIfaces: [] });
if (!getSetting('plans', null)) setJSON('plans', DEFAULT_PLANS);
if (getSetting('autoApprove', null) === null) setSetting('autoApprove', '0');

console.log('▶ WiFi Hub — الخادم الداخلي');
console.log('  قاعدة البيانات :', process.env.WIFIHUB_DB || path.join(process.cwd(), 'data', 'wifihub.db'));
console.log('  لوحة الإدارة   :', seeded.username, '/', seeded.password ? seeded.password + '  (غيّرها فوراً من اللوحة)' : '(مضبوطة مسبقاً)');
console.log('  البوابة        : http://localhost:' + PORT);

startHeartbeat();

/* ===================== معالجة الطلبات ===================== */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    return res.end();
  }

  try {
    if (p.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(res, p);
  } catch (e) {
    console.error('✖', req.method, p, e);
    try { sendJSON(res, 500, { ok: false, error: e.message || 'خطأ داخلي' }); } catch (_) {}
  }
});

/* ===================== الملفات الثابتة ===================== */
function serveStatic(res, p) {
  let rel = decodeURIComponent(p);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('غير موجود');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

/* ===================== واجهة البرمجة ===================== */
async function api(req, res, url) {
  const p = url.pathname;
  const method = req.method.toUpperCase();
  const token = tokenOf(req, url);
  const me = sessionUser(token);

  /* ---------- العلن ---------- */
  if (p === '/api/public/config' && method === 'GET') {
    const app = getAppCfg();
    return sendJSON(res, 200, {
      ok: true,
      app: { name: app.name, owner: app.owner, whatsapp: app.whatsapp, currency: app.currency },
      plans: getPlans(),
      features: getJSON('features', { wifi: true, block: true, freeze: true, limit: true, rename: true, reboot: false }),
      adminUsername: adminCredentials().username,
      serverTime: Date.now()
    });
  }

  /* ---------- التسجيل ---------- */
  if (p === '/api/auth/register' && method === 'POST') {
    const b = await readBody(req);
    const username = String(b.username || '').trim();
    const pass = String(b.password || '');
    if (username.length < 3) return sendJSON(res, 400, { ok: false, error: 'اسم المستخدم 3 أحرف على الأقل' });
    if (pass.length < 4) return sendJSON(res, 400, { ok: false, error: 'كلمة المرور 4 أحرف على الأقل' });
    if (findUser(username)) return sendJSON(res, 409, { ok: false, error: 'اسم المستخدم محجوز — اختر اسماً آخر' });
    const { salt, hash } = hashPassword(pass);
    const u = createUser({ username, pass: hash, salt, phone: String(b.phone || '').slice(0, 40) });
    const s = issueSession(u, !!b.remember);
    logEvent('user.register', username);
    broadcast('users.changed', { username });
    return sendJSON(res, 200, { ok: true, token: s.token, expires: s.expires, user: publicUser(u) });
  }

  /* ---------- الدخول ---------- */
  if (p === '/api/auth/login' && method === 'POST') {
    const b = await readBody(req);
    const username = String(b.username || '').trim();
    const pass = String(b.password || '');
    const u = findUser(username);
    if (!u || !verifyPassword(pass, u.salt, u.pass)) {
      return sendJSON(res, 401, { ok: false, error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    const s = issueSession(u, !!b.remember);
    logEvent('user.login', u.username);
    return sendJSON(res, 200, { ok: true, token: s.token, expires: s.expires, user: publicUser(u) });
  }

  /* ---------- الخروج ---------- */
  if (p === '/api/auth/logout' && method === 'POST') {
    revokeSession(token);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---------- من أنا ---------- */
  if (p === '/api/me' && method === 'GET') {
    if (!me) return sendJSON(res, 401, { ok: false, error: 'الجلسة منتهية — سجّل الدخول مجدداً' });
    return sendJSON(res, 200, { ok: true, user: publicUser(me, true) });
  }

  /* ---------- تفعيل كود ---------- */
  if (p === '/api/redeem' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { ok: false, error: 'الجلسة منتهية' });
    const b = await readBody(req);
    const code = String(b.code || '').trim().toUpperCase();
    if (!code) return sendJSON(res, 400, { ok: false, error: 'أدخل الكود' });
    const c = findCode(code);
    if (!c) return sendJSON(res, 404, { ok: false, error: 'الكود غير صالح' });
    if (c.used_by) return sendJSON(res, 409, { ok: false, error: 'هذا الكود مُستخدم مسبقاً — كل كود يُستخدم مرة واحدة فقط' });
    if (c.expires_at && c.expires_at < Date.now()) return sendJSON(res, 410, { ok: false, error: 'انتهت صلاحية الكود' });
    const plan = planById(c.plan);
    if (!plan) return sendJSON(res, 400, { ok: false, error: 'باقة غير معروفة' });

    const resv = db.prepare('UPDATE codes SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL')
      .run(me.username, Date.now(), code);
    if (!resv.changes) return sendJSON(res, 409, { ok: false, error: 'هذا الكود مُستخدم مسبقاً' });

    const base = me.sub_end && me.sub_end > Date.now() ? me.sub_end : Date.now();
    const end = base + plan.days * 864e5;
    updateUser(me.id, {
      plan: plan.id, sub_start: me.sub_start || Date.now(), sub_end: end,
      max_dev: c.max_dev || plan.maxDev, status: 'premium'
    });
    logEvent('sub.activated', me.username, { code, plan: plan.id, end });
    broadcast('subscribers.changed', { username: me.username });
    toUser(me.username, 'subscription.activated', { plan: plan.id, end, days: plan.days });
    const fresh = findUser(me.username);
    return sendJSON(res, 200, { ok: true, plan, user: publicUser(fresh, true), message: `تم تفعيل باقة «${plan.label}» — ${plan.days} يوم` });
  }

  /* ---------- الطلبات ---------- */
  if (p === '/api/request' && method === 'POST') {
    if (!me) return sendJSON(res, 401, { ok: false, error: 'الجلسة منتهية' });
    const b = await readBody(req);
    const plan = String(b.plan || '');
    const r = createRequest({ username: me.username, plan, phone: String(b.phone || me.phone || '').slice(0, 40) });
logEvent('request.created', me.username, { plan });
broadcast('requests.changed', { username: me.username });
if (getSetting('autoApprove', '0') === '1') {
const pl = planById(plan);
if (pl) {
const end = Date.now() + pl.days * 864e5;
updateUser(me.id, { plan: pl.id, sub_start: Date.now(), sub_end: end, max_dev: pl.maxDev, status: 'premium' });
updateRequest(r.id, { status: 'approved' });
broadcast('subscribers.changed', { username: me.username });
toUser(me.username, 'subscription.activated', { plan: pl.id, end, days: pl.days });
const fresh = findUser(me.username);
return sendJSON(res, 200, { ok: true, request: r, user: publicUser(fresh, true), autoApproved: true });
}
}
return sendJSON(res, 200, { ok: true, request: r, autoApproved: false });
}
/* ---------- أجهزة المشترك ---------- */
if (p === '/api/me/devices' && method === 'POST') {
if (!me) return sendJSON(res, 401, { ok: false, error: 'الجلسة منتهية' });
const b = await readBody(req);
const list = Array.isArray(b.devices) ? b.devices.slice(0, 200) : [];
updateUser(me.id, { devices: JSON.stringify(list) });
broadcast('subscribers.changed', { username: me.username });
return sendJSON(res, 200, { ok: true, count: list.length });
}
/* ---------- مزامنة كلمة مرور الراوتر ---------- */
if (p === '/api/me/router-password' && method === 'POST') {
if (!me) return sendJSON(res, 401, { ok: false, error: 'الجلسة منتهية' });
if (!isPremiumUser(me)) return sendJSON(res, 403, { ok: false, error: 'هذه الميزة للمشتركين المدفوعين' });
const b = await readBody(req);
const np = String(b.password || '');
if (np.length < 5) return sendJSON(res, 400, { ok: false, error: 'كلمة المرور قصيرة' });
const rc = getRouterCfg();
setJSON('router', Object.assign({}, rc, { password: np }));
logEvent('router.password', me.username);
broadcast('settings.changed', { username: me.username });
return sendJSON(res, 200, { ok: true });
}
/* ---------- الأحداث اللحظية ---------- */
if (p === '/api/stream' && method === 'GET') {
if (!me) return sendJSON(res, 401, { ok: false, error: 'غير مصرّح' });
const id = token + ':' + Math.random().toString(36).slice(2);
addClient(id, res, me.username, me.role);
req.on('close', () => removeClient(id));
return;
}
/* ===================== لوحة الإدارة ===================== */
if (p.startsWith('/api/admin/')) {
if (!me) return sendJSON(res, 401, { ok: false, error: 'سجّل الدخول كمدير' });
if (me.role !== 'admin') return sendJSON(res, 403, { ok: false, error: 'صلاحية المدير فقط' });
if (p === '/api/admin/overview' && method === 'GET') {
const users = listUsers();
const codes = listCodes();
const requests = listRequests();
const subscribers = users.map(u => ({
id: u.id,
username: u.username,
role: u.role,
status: u.role === 'admin' ? 'admin' : (u.sub_end && u.sub_end > Date.now() ? 'premium' : 'free'),
plan: u.plan || '',
subStart: u.sub_start || 0,
subEnd: u.sub_end || 0,
daysLeft: daysLeftOf(u),
maxDev: u.max_dev || 0,
devices: (() => { try { return JSON.parse(u.devices || '[]'); } catch (e) { return []; } })(),
phone: u.phone || '',
lastSeen: u.last_seen || 0,
created: u.created || 0,
code: (codes.find(c => c.used_by && c.used_by.toLowerCase() === u.username.toLowerCase()) || {}).code || ''
}));
const premium = subscribers.filter(s => s.status === 'premium').length;
const free = subscribers.filter(s => s.status === 'free').length;
return sendJSON(res, 200, {
ok: true,
stats: {
users: subscribers.length,
premium, free,
pendingRequests: requests.filter(r => r.status === 'pending').length,
codesTotal: codes.length,
codesUsed: codes.filter(c => c.used_by).length,
codesAvailable: codes.filter(c => !c.used_by).length,
online: clientCount()
},
subscribers,
codes: codes.map(c => ({
code: c.code, plan: c.plan, maxDev: c.max_dev, expiresAt: c.expires_at,
usedBy: c.used_by || '', usedAt: c.used_at, created: c.created, note: c.note || ''
})),
requests: requests.map(r => ({
id: r.id, username: r.username, plan: r.plan, phone: r.phone,
at: r.at, status: r.status, note: r.note || ''
})),
settings: {
app: getAppCfg(),
router: getRouterCfg(),
plans: getPlans(),
adminUsername: adminCredentials().username,
autoApprove: getSetting('autoApprove', '0') === '1',
features: getJSON('features', {})
},
events: recentEvents(30)
});
}
if (p === '/api/admin/codes' && method === 'POST') {
const b = await readBody(req);
const qty = Math.max(1, Math.min(500, Number(b.qty) || 1));
const plan = String(b.plan || (getPlans() || {}).id);
if (!planById(plan)) return sendJSON(res, 400, { ok: false, error: 'باقة غير معروفة' });
const maxDev = Math.max(1, Math.min(99, Number(b.maxDev) || 3));
let expires = Number(b.expiresAt) || 0;
const note = String(b.note || '').slice(0, 120);
const made = [];
for (let i = 0; i < qty; i++) {
let code, guard = 0;
do { code = generateCode(); guard++; } while (findCode(code) && guard < 20);
insertCode({ code, plan, max_dev: maxDev, expires_at: expires, note });
made.push(code);
}
logEvent('codes.generated', me.username, { qty, plan });
broadcast('codes.changed', { username: me.username });
return sendJSON(res, 200, { ok: true, codes: made });
}
const delCode = p.match(/^/api/admin/codes/([^/]+)$/);
if (delCode && method === 'DELETE') {
const code = decodeURIComponent(delCode[1]).toUpperCase();
db.prepare('DELETE FROM codes WHERE code = ?').run(code);
logEvent('codes.deleted', me.username, { code });
broadcast('codes.changed', { username: me.username });
return sendJSON(res, 200, { ok: true });
}
const sub = p.match(/^/api/admin/subscribers/([^/]+)(?:/(extend|promote))?$/);
if (sub) {
const username = decodeURIComponent(sub[1]);
const u = findUser(username);
if (!u) return sendJSON(res, 404, { ok: false, error: 'المستخدم غير موجود' });
if (method === 'DELETE') {
db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
logEvent('subscriber.deleted', username);
broadcast('users.changed', { username });
toUser(username, 'account.removed', {});
return sendJSON(res, 200, { ok: true });
}
if (method === 'POST' && sub[2] === 'extend') {
const b = await readBody(req);
const days = Math.max(1, Math.min(3650, Number(b.days) || 30));
const base = u.sub_end && u.sub_end > Date.now() ? u.sub_end : Date.now();
const end = base + days * 864e5;
updateUser(u.id, { sub_end: end, status: 'premium' });
logEvent('sub.extended', username, { days, end });
broadcast('subscribers.changed', { username });
toUser(username, 'subscription.activated', { plan: u.plan, end, days });
return sendJSON(res, 200, { ok: true, end });
}
if (method === 'POST' && sub[2] === 'promote') {
const b = await readBody(req);
const plan = planById(String(b.plan || u.plan || (getPlans() || {}).id));
if (!plan) return sendJSON(res, 400, { ok: false, error: 'باقة غير معروفة' });
const days = Math.max(1, Math.min(3650, Number(b.days) || plan.days));
const base = u.sub_end && u.sub_end > Date.now() ? u.sub_end : Date.now();
const end = base + days * 864e5;
updateUser(u.id, { plan: plan.id, sub_start: u.sub_start || Date.now(), sub_end: end, max_dev: plan.maxDev, status: 'premium' });
for (const r of listRequests()) {
if (r.username.toLowerCase() === username.toLowerCase() && r.status === 'pending') updateRequest(r.id, { status: 'approved' });
}
logEvent('sub.promoted', username, { plan: plan.id, end });
broadcast('subscribers.changed', { username });
toUser(username, 'subscription.activated', { plan: plan.id, end, days });
return sendJSON(res, 200, { ok: true, end, plan });
}
}
const reqAct = p.match(/^/api/admin/requests/(\d+)/(approve|reject)$/);
if (reqAct && method === 'POST') {
const id = Number(reqAct[1]);
const r = findRequest(id);
if (!r) return sendJSON(res, 404, { ok: false, error: 'الطلب غير موجود' });
if (reqAct[2] === 'reject') {
updateRequest(id, { status: 'rejected' });
broadcast('requests.changed', { username: r.username });
toUser(r.username, 'request.rejected', {});
return sendJSON(res, 200, { ok: true });
}
const b = await readBody(req);
const u = findUser(r.username);
const plan = planById(String(b.plan || r.plan || (getPlans() || {}).id));
if (!plan) return sendJSON(res, 400, { ok: false, error: 'باقة غير معروفة' });
const days = Math.max(1, Math.min(3650, Number(b.days) || plan.days));
let end = Date.now() + days * 864e5;
if (u) {
const base = u.sub_end && u.sub_end > Date.now() ? u.sub_end : Date.now();
end = base + days * 864e5;
updateUser(u.id, { plan: plan.id, sub_start: u.sub_start || Date.now(), sub_end: end, max_dev: plan.maxDev, status: 'premium' });
}
const code = String(b.code || '').trim().toUpperCase();
if (code) {
const c = findCode(code);
if (c && !c.used_by) {
db.prepare('UPDATE codes SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL')
.run(r.username, Date.now(), code);
}
}
updateRequest(id, { status: 'approved' });
logEvent('request.approved', r.username, { plan: plan.id, days });
broadcast('requests.changed', { username: r.username });
broadcast('subscribers.changed', { username: r.username });
toUser(r.username, 'subscription.activated', { plan: plan.id, end, days });
return sendJSON(res, 200, { ok: true });
}
if (p === '/api/admin/settings' && method === 'POST') {
const b = await readBody(req);
if (b.app) setJSON('app', Object.assign(getAppCfg(), b.app));
if (b.router) setJSON('router', Object.assign(getRouterCfg(), b.router));
if (Array.isArray(b.plans) && b.plans.length) setJSON('plans', b.plans);
if (b.features) setJSON('features', b.features);
if (b.autoApprove != null) setSetting('autoApprove', b.autoApprove ? '1' : '0');
if (b.adminUsername || b.adminPassword) {
const u = String(b.adminUsername || adminCredentials().username).trim();
const pw = String(b.adminPassword || '');
if (u.length < 3) return sendJSON(res, 400, { ok: false, error: 'اسم المستخدم قصير' });
if (pw && pw.length < 4) return sendJSON(res, 400, { ok: false, error: 'كلمة المرور قصيرة' });
changeAdminCredentials(u, pw || null);
}
logEvent('settings.saved', me.username);
broadcast('settings.changed', { username: me.username });
return sendJSON(res, 200, { ok: true });
}
if (p === '/api/admin/export/codes.csv' && method === 'GET') {
const rows = listCodes();
const csv = 'code,plan,maxDev,status,usedBy,usedAt,expiresAt,note\n' +
rows.map(c => [c.code, c.plan, c.max_dev, c.used_by ? 'used' : 'available', c.used_by || '', c.used_at || '', c.expires_at || '', (c.note || '').replace(/[,\n]/g, ' ')].join(',')).join('\n');
res.writeHead(200, {
'Content-Type': 'text/csv; charset=utf-8',
'Content-Disposition': 'attachment; filename="wifihub-codes.csv"',
'Access-Control-Allow-Origin': '*'
});
return res.end('\ufeff' + csv);
}
}
return sendJSON(res, 404, { ok: false, error: 'المسار غير موجود' });
}
/* ===================== تمثيل المستخدم ===================== */
function publicUser(u, withRouter = false) {
const premium = isPremiumUser(u);
const app = getAppCfg();
const out = {
id: u.id,
username: u.username,
role: u.role,
status: u.role === 'admin' ? 'admin' : (premium ? 'premium' : 'free'),
premium,
plan: u.plan || '',
subStart: u.sub_start || 0,
subEnd: u.sub_end || 0,
daysLeft: daysLeftOf(u),
maxDev: u.max_dev || 0,
phone: u.phone || '',
created: u.created || 0
};
if (withRouter && (premium || u.role === 'admin')) {
const rc = getRouterCfg();
out.router = { base: rc.base || '', username: rc.username || 'root', password: rc.password || '' };
} else {
out.router = null;
}
out.app = { name: app.name, whatsapp: app.whatsapp, currency: app.currency, owner: app.owner };
out.plans = getPlans();
return out;
}
/* ===================== التشغيل ===================== */
server.listen(PORT, HOST, () => {
console.log(✔ يعمل على http://localhost:${PORT});
});
