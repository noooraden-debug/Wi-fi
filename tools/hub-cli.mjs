#!/usr/bin/env node
/* أداة إدارة ملف hub.json من سطر الأوامر (للمدير — اختيارية، كل شيء متاح من التطبيق)
 *
 *   node tools/hub-cli.mjs validate hub.json
 *   node tools/hub-cli.mjs codes  hub.json --plan m1 --qty 10 --maxdev 3
 *   node tools/hub-cli.mjs add     hub.json --user ahmad --plan m1
 *   node tools/hub-cli.mjs extend  hub.json --user ahmad --days 30
 *   node tools/hub-cli.mjs remove  hub.json --user ahmad
 *   node tools/hub-cli.mjs push    hub.json --repo OWNER/REPO --branch main --token ghp_xxx
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const [, , cmd, file, ...rest] = process.argv;
if (!cmd || !file) { console.error('الاستخدام: node tools/hub-cli.mjs <الأمر> <hub.json> [خيارات]'); process.exit(1); }

const arg = (name, def = null) => {
  const i = rest.indexOf('--' + name);
  return i >= 0 ? rest[i + 1] : def;
};

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const plans = data.plans || [];
const planOf = id => plans.find(p => p.id === id);

function save() { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
function randCode() {
  /* نفس خوارزمية التطبيق: 20 خانة عشوائية آمنة مقسّمة إلى 4 مجموعات */
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(20);
  let s = '';
  for (const x of b) s += A[x % A.length];
  return 'WH-' + s.slice(0, 5) + '-' + s.slice(5, 10) + '-' + s.slice(10, 15) + '-' + s.slice(15, 20);
}

switch (cmd) {
  case 'validate': {
    const need = ['app', 'plans', 'router', 'codes', 'subscribers'];
    const missing = need.filter(k => !(k in data));
    console.log(missing.length ? '✘ حقول ناقصة: ' + missing.join(', ') : '✔ الملف صالح');
    if (!data.router || !data.router.password || data.router.password === 'CHANGE_ME')
      console.log('⚠︎ تذكير: اضبط router.password قبل النشر');
    process.exit(missing.length ? 1 : 0);
  }

  case 'codes': {
    const plan = arg('plan', 'm1');
    const qty = Number(arg('qty', '10'));
    const maxDev = Number(arg('maxdev', '3'));
    const days = Number(arg('days', '0'));
    if (!planOf(plan)) { console.error('✘ باقة غير معروفة: ' + plan); process.exit(1); }
    data.codes = data.codes || [];
    const made = [];
    for (let i = 0; i < qty; i++) {
      let code; do { code = randCode(); } while (data.codes.some(c => c.code === code));
      data.codes.unshift({
        code, plan, maxDev, price: planOf(plan).price, created: Date.now(),
        expiresAt: days ? Date.now() + days * 864e5 : 0, usedBy: '', usedAt: 0
      });
      made.push(code);
    }
    save();
    console.log('✔ تم توليد ' + made.length + ' كود:\n' + made.join('\n'));
    break;
  }

  case 'add': {
    const user = arg('user'), plan = arg('plan', 'm1');
    if (!user || !planOf(plan)) { console.error('✘ استخدم --user و--plan صحيحاً'); process.exit(1); }
    data.subscribers = data.subscribers || [];
    const p = planOf(plan);
    const rec = { id: 'u' + Date.now().toString(36), username: user, plan, start: Date.now(), end: Date.now() + p.days * 864e5, maxDev: p.maxDev, devices: [] };
    data.subscribers.push(rec);
    save();
    console.log('✔ تمت إضافة المشترك ' + user + ' حتى ' + new Date(rec.end).toLocaleDateString('ar'));
    break;
  }

  case 'extend': {
    const user = arg('user'), days = Number(arg('days', '30'));
    const s = (data.subscribers || []).find(x => x.username === user);
    if (!s) { console.error('✘ غير موجود: ' + user); process.exit(1); }
    s.end = Math.max(Date.now(), s.end || Date.now()) + days * 864e5;
    save();
    console.log('✔ تمديد ' + user + ' حتى ' + new Date(s.end).toLocaleDateString('ar'));
    break;
  }

  case 'remove': {
    const user = arg('user');
    data.subscribers = (data.subscribers || []).filter(x => x.username !== user);
    save();
    console.log('✔ تم حذف ' + user);
    break;
  }

  case 'admin': {
    const user = arg('user', 'admin');
    const pass = arg('pass', 'admin');
    if (!user || pass.length < 4) { console.error('✘ اسم مستخدم أو كلمة مرور غير صالحة'); process.exit(1); }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(salt + ':' + pass).digest('hex');
    data.app = Object.assign({}, data.app, { admin: { username: user, salt, hash } });
    delete data.app.adminPass;
    save();
    console.log('✔ بيانات الإدارة: المستخدم=' + user + ' (كلمة المرور مُشفَّرة، لم تُطبع)');
    console.log('  رابط دخول الإدارة: ' + (arg('repo') ? 'https://github.com/' + arg('repo') : '(رابط المستودع)') + '/blob/main/hub.json');
    break;
  }

  case 'routerpass': {
    const pass = arg('pass');
    if (!pass || pass.length < 5) { console.error('✘ استخدم --pass بكلمة مرور (5 أحرف على الأقل)'); process.exit(1); }
    data.router = Object.assign({}, data.router, { password: pass });
    save();
    console.log('✔ حُدّثت كلمة مرور الراوتر في ملف الإعدادات');
    break;
  }

  case 'push': {
    const repo = arg('repo'), branch = arg('branch', 'main'), token = arg('token');
    if (!repo || !token) { console.error('✘ استخدم --repo OWNER/REPO و--token'); process.exit(1); }
    const [owner, name] = repo.split('/');
    const path = file.split('/').pop();
    const url = `https://api.github.com/repos/${owner}/${name}/contents/${path}`;
    const headers = { 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
    let sha = null;
    const cur = await fetch(`${url}?ref=${branch}`, { headers });
    if (cur.ok) sha = (await cur.json()).sha;
    const body = { message: 'wifihub: تحديث الإعدادات', content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'), branch };
    if (sha) body.sha = sha;
    const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (!res.ok) { console.error('✘ فشل الرفع:', (await res.text()).slice(0, 200)); process.exit(1); }
    console.log('✔ تم الرفع إلى GitHub: https://raw.githubusercontent.com/' + owner + '/' + name + '/' + branch + '/' + path);
    break;
  }

  default:
    console.error('أمر غير معروف: ' + cmd);
    process.exit(1);
}
