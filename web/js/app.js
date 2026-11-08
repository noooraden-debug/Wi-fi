/* WiFi Hub — منطق التطبيق */

import { $, $$, esc, fmtBytes, fmtDate, fmtDateTime, daysLeft, relTime, store, toast, sleep, now, randomCode, randomPassword } from './util.js';
import { Config } from './config.js';
import { Router } from './router.js';
import { Accounts } from './accounts.js';
import { makeHash, verifyPassword, safeEqual, randomSalt } from './hash.js';

const BUILD = (globalThis.WIFIHUB_BUILD || {});   // يُحقن وقت البناء (رابط الإعدادات + توكن القراءة)

let CFG = null, ROUTER = null, ACC = null, ME = null, DEVICES = [], SECTION = 'dash';
let FREEZES = store.get('freezes', {});
let LOG = store.get('log', []);

/* ============================ الإقلاع ============================ */
async function boot() {
  applyTheme();
  const url = BUILD.configUrl || store.get('cfg.url', '');
  const token = BUILD.readToken || store.get('cfg.token', '');
  if (!url) { $('#setupBox').classList.remove('hide'); $('#loginBox').classList.add('hide'); $('#setupFoot').textContent = ''; return; }
  try {
    CFG = await Config.load(url, token);
  } catch (e) {
    $('#setupBox').classList.remove('hide');
    $('#loginBox').classList.add('hide');
    $('#cfgUrl').value = url;
    showErr('#setupErr', e.message);
    $('#setupFoot').textContent = '';
    return;
  }
  ROUTER = new Router(CFG.router);
  ACC = new Accounts(CFG);
  ACC.writeToken = store.get('gh.writeToken', '');
  $('#appTitle').textContent = (CFG.data.app && CFG.data.app.name) || 'WiFi Hub';
  const au = (CFG.data.app && CFG.data.app.admin && CFG.data.app.admin.username) || 'admin';
  const aEl = $('#aUser'); if (aEl && !aEl.value) aEl.value = au;
  $('#appOwner').textContent = 'تحكّم بشبكتك واشتراكك';
  $('#setupFoot').textContent = CFG.remote ? '✔ متصل بإعدادات GitHub' : '⚠︎ يعمل بالنسخة المحفوظة (لا يوجد إنترنت)';
  $('#loginBox').classList.remove('hide');
  $('#setupBox').classList.add('hide');

  const sess = store.get('session', null);
  if (sess && sess.role) {
    try { await enterApp(sess); } catch (e) { /* أعد للدخول */ }
  }
}

async function saveSetup() {
  const url = $('#cfgUrl').value.trim();
  const token = $('#cfgToken').value.trim();
  if (!url) return showErr('#setupErr', 'أدخل رابط الإعدادات');
  store.set('cfg.url', url); store.set('cfg.token', token);
  hideErr('#setupErr');
  await boot();
}

/* ============================ الدخول ============================ */
function authTab(t) {
  ['login', 'reg', 'admin'].forEach(x => $('#pane' + x[0].toUpperCase() + x.slice(1)).classList.toggle('hide', t !== x));
  $('#tabLogin').classList.toggle('on', t === 'login');
  $('#tabReg').classList.toggle('on', t === 'reg');
  $('#tabAdmin').classList.toggle('on', t === 'admin');
  hideErr('#lErr'); hideErr('#rErr'); hideErr('#aErr');
}

function localUsers() { return store.get('users', []); }
function localUser(u) { return localUsers().find(x => x.username.toLowerCase() === String(u).toLowerCase()); }

async function doRegister() {
  hideErr('#rErr');
  const username = $('#rUser').value.trim(), p1 = $('#rPass').value, p2 = $('#rPass2').value;
  if (username.length < 3) return showErr('#rErr', 'اسم المستخدم 3 أحرف على الأقل');
  if (p1.length < 4) return showErr('#rErr', 'كلمة المرور 4 أحرف على الأقل');
  if (p1 !== p2) return showErr('#rErr', 'كلمتا المرور غير متطابقتين');
  if (localUser(username)) return showErr('#rErr', 'الاسم محجوز');
  const u = { username, pass: p1, created: now() };
  const arr = localUsers(); arr.push(u); store.set('users', arr);
  store.set('session', { role: 'user', username });
  await enterApp({ role: 'user', username });
  toast('تم إنشاء حسابك', 'ok');
  /* إبلاغ الإدارة بالمستخدم المجاني ليظهر في لوحتها */
  await sendRequest('register', '', null, {});
}

async function doLogin() {
  hideErr('#lErr');
  const username = $('#lUser').value.trim(), pass = $('#lPass').value;
  if (!username || !pass) return showErr('#lErr', 'أدخل اسم المستخدم وكلمة المرور');
  const u = localUser(username);
  if (!u) return showErr('#lErr', 'لا يوجد حساب بهذا الاسم — أنشئ حساباً من تبويب «حساب جديد»');
  if (u.pass !== pass) return showErr('#lErr', 'كلمة المرور غير صحيحة');
  store.set('session', { role: 'user', username });
  await enterApp({ role: 'user', username });
}

async function doAdminLogin() {
  hideErr('#aErr');
  const app = CFG.data.app || {};
  const admin = app.admin || {};
  const user = (admin.username || 'admin');
  const pass = $('#aPass').value;
  let okPass = false;
  if (admin.hash) okPass = await verifyPassword(pass, admin.salt, admin.hash);
  else if (app.adminPass) okPass = safeEqual(pass, app.adminPass);   /* توافق مع الإعدادات القديمة */
  if (!safeEqual($('#aUser').value.trim() || 'admin', user)) okPass = false;
  if (!okPass) return showErr('#aErr', 'اسم المستخدم أو كلمة المرور غير صحيحة');
  if ($('#aToken').value.trim()) ACC.setWriteToken($('#aToken').value.trim());
  store.set('session', { role: 'admin' });
  await enterApp({ role: 'admin' });
}

/* تغيير اسم مستخدم الإدارة وكلمة مرورها (تُحفظ مُشفَّرة في hub.json) */
async function saveAdminCreds() {
  const app = CFG.data.app || (CFG.data.app = {});
  const user = $('#admUser').value.trim();
  const np = $('#admPass').value;
  if (!user || user.length < 3) return toast('اسم مستخدم الإدارة قصير (3 أحرف)', 'bad');
  if (!np || np.length < 4) return toast('كلمة مرور الإدارة قصيرة (4 أحرف)', 'bad');
  const { salt, hash } = await makeHash(np, randomSalt());
  await writeHub(async data => {
    data.app = Object.assign({}, data.app, {
      admin: { username: user, salt, hash },
      adminPass: undefined
    });
    if (data.app.adminPass === undefined) delete data.app.adminPass;
    return 'تم تحديث بيانات الإدارة (مُشفَّرة)';
  });
  app.admin = { username: user, salt, hash };
  delete app.adminPass;
  $('#admPass').value = '';
  toast('تم حفظ بيانات الإدارة الجديدة', 'ok');
}

async function doLogout() {
  store.set('session', null);
  ME = null;
  location.reload();
}

/* ============================ الدخول إلى التطبيق ============================ */
async function enterApp(sess) {
  ME = sess;
  if (ME.role === 'user') {
    const sub = CFG.subscribers.find(s => String(s.username).toLowerCase() === ME.username.toLowerCase());
    ME.sub = sub || null;
    ME.active = !!(sub && sub.end > now());
  } else {
    ME.sub = null; ME.active = true;
  }
  $('#authView').classList.add('hide');
  $('#appView').classList.remove('hide');
  $('#whoName').textContent = ME.role === 'admin' ? 'مدير النظام' : ME.username;
  $('#whoRole').innerHTML = ME.role === 'admin' ? '<span class="pill p-warn">👑 لوحة الإدارة</span>' : '<span class="pill p-info">مشترك</span>';
  buildNav();
  await showSection('dash');
  connectRouter();
  startPolling();
}

function buildNav() {
  const nav = ME.role === 'admin'
    ? [{ id: 'dash', label: 'لوحة التحكم', icon: '📊' }, { id: 'dev', label: 'الأجهزة', icon: '📱' },
       { id: 'wifi', label: 'الواي فاي', icon: '📶' }, { id: 'sub', label: 'الباقات', icon: '🎫' },
       { id: 'admin', label: 'الإدارة', icon: '👑' }]
    : [{ id: 'dash', label: 'لوحة التحكم', icon: '📊' }, { id: 'dev', label: 'الأجهزة', icon: '📱' },
       { id: 'wifi', label: 'الواي فاي', icon: '🔑' }, { id: 'sub', label: 'اشتراكي', icon: '🎫' }];
  $('#nav').innerHTML = nav.map(n => `<button data-s="${n.id}" onclick="showSection('${n.id}')">${n.icon} ${n.label}</button>`).join('');
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.s === SECTION));
}

async function showSection(id) {
  SECTION = id;
  ['Dash', 'Dev', 'Wifi', 'Sub', 'Admin'].forEach(s => $('#sec' + s).classList.add('hide'));
  $('#sec' + id[0].toUpperCase() + id.slice(1)).classList.remove('hide');
  buildNav();
  if (id === 'dash') renderDash();
  if (id === 'dev') renderDevices();
  if (id === 'wifi') renderWifi();
  if (id === 'sub') renderSub();
  if (id === 'admin') renderAdmin();
}

/* ============================ الاتصال بالراوتر ============================ */
async function connectRouter() {
  const chip = $('#netChip');
  chip.className = 'pill p-warn'; chip.textContent = '🔌 جارٍ الاتصال بالراوتر';
  try {
    const b = await ROUTER.connect();
    chip.className = 'pill p-ok'; chip.textContent = '🔌 متصل';
    await unfreezeExpired();
    await loadBlocks();
    refreshAll();
  } catch (e) {
    chip.className = 'pill p-bad'; chip.textContent = '⚠️ ' + (e.message || 'تعذّر الاتصال');
    toast(e.message, 'bad');
  }
}

async function refreshAll() {
  if (!ROUTER.connected) { await connectRouter(); return; }
  try {
    DEVICES = await ROUTER.clients();
    const chip = $('#netChip');
    chip.className = 'pill p-ok'; chip.textContent = '🔌 متصل (' + DEVICES.length + ' جهاز)';
  } catch (e) {
    toast('تعذّر جلب الأجهزة: ' + e.message, 'bad');
  }
  if (SECTION === 'dash') renderDash();
  if (SECTION === 'dev') renderDevices();
}

/* حالة الحظر/التجميد: نقرأها من الراوتر + التخزين المحلي */
let BLOCKED = new Set();
async function loadBlocks() {
  BLOCKED = new Set();
  try {
    const u = await ROUTER.ensure();
    const raw = await u.call('uci', 'get', { config: 'firewall' });
    const vals = (raw && raw.values) || {};
    for (const k of Object.keys(vals)) {
      if (/^hubblk/i.test(k)) {
        const n = k.includes('.') ? k.split('.')[1] : k;
        const nm = (vals[k] && vals[k].name) || '';
        const m = String(nm).replace(/HubBlock-?/i, '');
        if (m) BLOCKED.add(m.toLowerCase());
      }
    }
  } catch (e) {}
}
const macKey = m => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');
const isBlocked = mac => BLOCKED.has(macKey(mac));
const isFrozen = mac => (FREEZES[macKey(mac)] || 0) > now();

async function unfreezeExpired() {
  for (const k of Object.keys(FREEZES)) {
    if (FREEZES[k] < now()) {
      delete FREEZES[k];
      try { await ROUTER.unblockDevice(k); } catch (e) {}
    }
  }
  store.set('freezes', FREEZES);
}

/* ============================ العرض ============================ */
/* هل المستخدم مشترك مدفوع (بريميوم)؟ */
function isPremium() { return !!(ME && (ME.role === 'admin' || ME.active)); }
function myDaysLeft() {
  if (!ME || !ME.sub || !ME.sub.end) return 0;
  return Math.max(0, Math.ceil((Number(ME.sub.end) - Date.now()) / 86400000));
}
function deviceState(d) {
  if (isBlocked(d.mac)) return { t: 'محظور', c: 'p-bad' };
  if (isFrozen(d.mac)) return { t: 'مجمّد', c: 'p-warn' };
  if (d.online) return { t: 'متصل', c: 'p-ok' };
  return { t: 'غير متصل', c: 'p-muted' };
}
const TICON = { phone: '📱', laptop: '💻', tv: '📺', iot: '🔌', wearable: '⌚', printer: '🖨️', other: '📦' };
const TYPES = { phone: 'هاتف', laptop: 'حاسوب', tv: 'تلفاز', iot: 'جهاز ذكي', wearable: 'ساعة', printer: 'طابعة', other: 'أخرى' };

function renderDash() {
  const online = DEVICES.filter(d => d.online).length;
  const usage = DEVICES.reduce((a, d) => a + (d.usage || 0), 0);
  const st = [
    ['الأجهزة', DEVICES.length, '📱'], ['متصل الآن', online, '🟢'],
    ['الاستهلاك', fmtBytes(usage), '📊'],
    ME.role === 'admin' ? ['المشتركون', CFG.subscribers.length, '👥']
      : (ME.active ? ['المتبقي (يوم)', myDaysLeft(), '⏳'] : ['الباقة', 'مجاني', '🎫'])
  ];
  $('#dashStats').innerHTML = st.map(s => `<div class="card stat"><span>${s[2]} ${s[0]}</span><b>${s[1]}</b></div>`).join('');

  const b = $('#subBanner');
  const pending = store.get('pendingSub', null);
  const pendingReq = (CFG.requests || []).find(r => r.username === ME.username && (!r.status || r.status === 'pending'));
  if (ME.role !== 'admin' && !ME.active) {
    b.className = 'banner';
    if (pending || pendingReq) {
      b.innerHTML = `<span style="font-size:22px">⏳</span>
        <div style="flex:1;min-width:220px"><b>طلبك قيد المراجعة</b>
        <div class="small dim">سجّلنا طلبك للمشرف. فور اعتماده تُفتح كل المميزات تلقائياً هنا — لا تحتاج إلى فعل أي شيء إضافي.</div></div>
        <button class="btn sm" onclick="refreshSubscription()">↻ تحديث الحالة</button>`;
    } else if (ME.sub && ME.sub.end && ME.sub.end <= now()) {
      b.className = 'banner bad';
      b.innerHTML = `<span style="font-size:22px">⌛</span>
        <div style="flex:1;min-width:220px"><b>انتهت باقتك</b>
        <div class="small dim">أُعيدت المميزات إلى الوضع المجاني. فعّل كوداً جديداً لتعود المميزات فوراً.</div></div>
        <button class="btn wa" onclick="waRequest()">📲 اطلب باقة جديدة</button>
        <button class="btn p" onclick="openRedeem()">🎟️ أدخل الكود</button>`;
    } else {
      b.innerHTML = `<span style="font-size:22px">🔒</span>
        <div style="flex:1;min-width:220px"><b>اشتراكك غير مفعّل</b>
        <div class="small dim">اطلب الباقة أو أدخل الكود الذي وصلك. بعد موافقة المشرف تُفتح كل المميزات تلقائياً — بلا أي خطوة تقنية.</div></div>
        <button class="btn wa" onclick="waRequest()">📲 اطلب الباقة</button>
        <button class="btn p" onclick="openRedeem()">🎟️ أدخل الكود</button>`;
    }
    b.classList.remove('hide');
  } else b.classList.add('hide');

  $('#tblDash').innerHTML = deviceTable(DEVICES.slice(0, 12), false);
  renderNetState();
}

async function renderNetState() {
  const box = $('#netState');
  box.innerHTML = '<div class="dim small">جارٍ القراءة…</div>';
  try {
    const b = await ROUTER.board();
    const i = await ROUTER.info();
    const up = i.uptime ? Math.floor(i.uptime / 60) + ' دقيقة' : '—';
    const mem = i.sys && i.sys.memory ? `الذاكرة: ${Math.round((i.sys.memory.free / i.sys.memory.total) * 100)}% متاحة` : '';
    box.innerHTML = `
      <div class="kv"><span>الطراز</span><b>${esc(b.model || b.release || 'OpenWrt')}</b></div>
      <div class="kv"><span>الإصدار</span><b>${esc((b.release && b.release.description) || '—')}</b></div>
      <div class="kv"><span>مدة التشغيل</span><b>${up}</b></div>
      <div class="kv"><span>الذاكرة</span><b>${esc(mem || '—')}</b></div>
      <div class="kv"><span>العنوان</span><b class="mono" style="direction:ltr">${esc(ROUTER.base)}</b></div>`;
  } catch (e) {
    box.innerHTML = `<div class="dim small">تعذّر قراءة معلومات الراوتر: ${esc(e.message)}</div>`;
  }
}

function renderDevices() {
  const sel = $('#fType');
  if (!sel.options.length) sel.innerHTML = '<option value="">كل الأنواع</option>' +
    Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const q = ($('#fQ').value || '').toLowerCase();
  const ft = $('#fType').value, fs = $('#fState').value;
  const rows = DEVICES.filter(d => {
    if (ft && d.type !== ft) return false;
    const st = isBlocked(d.mac) ? 'blocked' : isFrozen(d.mac) ? 'frozen' : 'active';
    if (fs && st !== fs) return false;
    if (q && !((d.name || '') + ' ' + (d.ip || '') + ' ' + (d.mac || '')).toLowerCase().includes(q)) return false;
    return true;
  });
  if (ME.role !== 'admin' && !ME.active) {
    $('#tblDev').innerHTML = `<tbody><tr><td class="center" style="padding:32px">
      <div style="font-size:38px">🔒</div><b style="display:block;margin:6px 0">مزايا الاشتراك مقفلة</b>
      <div class="dim small" style="margin-bottom:12px">فعّل باقتك للتحكم الكامل بأجهزتك.</div>
      <button class="btn wa" onclick="waRequest()">📲 اطلب الكود</button>
      <button class="btn p" onclick="openRedeem()">🎟️ أدخل الكود</button></td></tr></tbody>`;
    return;
  }
  $('#tblDev').innerHTML = deviceTable(rows, true);
}

function deviceTable(rows, full) {
  let h = `<thead><tr><th>الجهاز</th><th>النوع</th>${full ? '<th>IP / MAC</th>' : ''}<th>الاستهلاك</th><th>الحالة</th>${full ? '<th>التحكم</th>' : ''}</tr></thead><tbody>`;
  if (!rows.length) h += `<tr><td colspan="6" class="center dim" style="padding:26px">لا توجد أجهزة مطابقة</td></tr>`;
  for (const d of rows) {
    const st = deviceState(d);
    const name = d.name || d.mac;
    h += `<tr>
      <td class="dcell"><div style="display:flex;align-items:center;gap:9px">
        <div class="avt">${TICON[d.type] || TICON.other}</div>
        <div class="nm"><div style="font-weight:700">${esc(name)}</div>
        <div class="dim small">${d.signal != null ? '📶 ' + d.signal + ' dBm' : ''} ${d.online ? 'متصل' : 'غير متصل'}</div></div></div></td>
      <td>${TYPES[d.type] || TYPES.other}</td>
      ${full ? `<td class="mono" style="direction:ltr;text-align:right">${esc(d.ip || '—')}<div class="dim small">${esc(d.mac)}</div></td>` : ''}
      <td><div style="font-weight:700">${fmtBytes(d.usage || 0)}</div></td>
      <td><span class="pill ${st.c}">${st.t}</span></td>
      ${full ? `<td style="white-space:normal">
        <button class="btn sm" onclick="doFreeze('${d.mac}')">❄️ ${isFrozen(d.mac) ? 'إلغاء' : 'تجميد'}</button>
        <button class="btn sm ${isBlocked(d.mac) ? 'g' : 'd'}" onclick="doBlock('${d.mac}')">🚫 ${isBlocked(d.mac) ? 'رفع الحظر' : 'حظر'}</button>
        <button class="btn sm" onclick="doRename('${d.mac}')">✏️</button></td>` : ''}
    </tr>`;
  }
  return h + '</tbody>';
}

/* ---------- أفعال الأجهزة ---------- */
async function doFreeze(mac) {
  try {
    if (isFrozen(mac)) {
      delete FREEZES[macKey(mac)]; store.set('freezes', FREEZES);
      await ROUTER.unblockDevice(mac);
      toast('تم إلغاء التجميد', 'ok');
    } else {
      const h = prompt('مدة التجميد بالساعات (مثال 12):', '12'); if (h === null) return;
      const hours = +h || 12;
      const d = DEVICES.find(x => x.mac === mac);
      if (!d || !d.ip) return toast('لا يوجد IP للجهاز', 'bad');
      await ROUTER.blockDevice(mac, d.ip);
      FREEZES[macKey(mac)] = now() + hours * 3600e3; store.set('freezes', FREEZES);
      toast(`تم تجميد الجهاز ${hours} ساعة`, 'ok');
    }
    await loadBlocks(); renderDevices(); renderDash();
  } catch (e) { toast(e.message, 'bad'); }
}

async function doBlock(mac) {
  try {
    if (isBlocked(mac)) {
      await ROUTER.unblockDevice(mac);
      toast('تم رفع الحظر', 'ok');
    } else {
      const d = DEVICES.find(x => x.mac === mac);
      if (!d || !d.ip) return toast('لا يوجد IP للجهاز', 'bad');
      await ROUTER.blockDevice(mac, d.ip);
      toast('تم حظر الجهاز', 'ok');
    }
    await loadBlocks(); renderDevices(); renderDash();
  } catch (e) { toast(e.message, 'bad'); }
}

async function doRename(mac) {
  const d = DEVICES.find(x => x.mac === mac);
  const name = prompt('الاسم الجديد للجهاز:', d ? (d.name || '') : '');
  if (!name) return;
  try { await ROUTER.renameDevice(mac, name); toast('تم تغيير الاسم', 'ok'); refreshAll(); }
  catch (e) { toast(e.message, 'bad'); }
}

/* ============================ الواي فاي ============================ */
async function renderWifi() {
  if (!isPremium()) {
    $('#wifiForm').classList.add('hide');
    $('#wifiLocked').classList.remove('hide');
    $('#wifiLocked').innerHTML = `<div style="font-size:40px;text-align:center">🔒</div>
      <b style="display:block;text-align:center;margin:6px 0 4px">كلمة مرور الواي فاي مقفلة</b>
      <div class="dim small center" style="max-width:360px;margin:0 auto 14px;line-height:1.9">
        تغيير اسم الشبكة وكلمة المرور متاح للمشتركين المدفوعين فقط. فعّل إحدى الباقات لتفتح كل المميزات.</div>
      <div style="display:flex;gap:9px;justify-content:center;flex-wrap:wrap">
        <button class="btn wa" onclick="waRequest()">📲 اطلب الباقة</button>
        <button class="btn p" onclick="openRedeem()">🎟️ أدخل الكود</button></div>`;
    return;
  }
  $('#wifiForm').classList.remove('hide');
  $('#wifiLocked').classList.add('hide');
  const box = $('#wifiState');
  box.innerHTML = '<div class="dim small">جارٍ القراءة…</div>';
  try {
    const st = await ROUTER.wifiState();
    $('#wSsid').value = st.ssid || '';
    box.innerHTML = `
      <div class="kv"><span>اسم الشبكة</span><b>${esc(st.ssid || '—')}</b></div>
      <div class="kv"><span>التشفير</span><b>${esc(st.encryption || '—')}</b></div>
      <div class="kv"><span>القنوات</span><b>${esc((st.channels || []).join('، ') || '—')}</b></div>
      <div class="kv"><span>عدد الواجهات</span><b>${st.ifaces.length}</b></div>`;
  } catch (e) {
    box.innerHTML = `<div class="dim small">تعذّر قراءة إعدادات الواي فاي: ${esc(e.message)}</div>`;
  }
  const l = LOG.filter(x => x.type === 'wifi').slice(0, 8);
  $('#pwLog').innerHTML = l.length ? l.map(x => `<div>${fmtDateTime(x.t)} — ${esc(x.txt)}</div>`).join('') : '<div>لا يوجد سجل بعد.</div>';
}

function pwMeter() {
  const v = $('#wPass').value;
  let s = 0;
  if (v.length >= 8) s++; if (v.length >= 12) s++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
  if (/\d/.test(v)) s++; if (/[^A-Za-z0-9]/.test(v)) s++;
  const pct = Math.min(100, s * 20);
  const bar = $('#pwBar');
  bar.style.width = pct + '%';
  bar.style.background = pct < 40 ? 'var(--bad)' : pct < 70 ? 'var(--warn)' : 'var(--ok)';
  $('#pwHint').textContent = v.length < 8 ? 'كلمة المرور يجب 8 أحرف على الأقل' : `قوة كلمة المرور: ${['ضعيفة', 'ضعيفة', 'مقبولة', 'جيدة', 'جيدة', 'قوية'][s] || 'مقبولة'}`;
}

function randPass(id) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = new Uint8Array(12); crypto.getRandomValues(b);
  $('#' + id).value = Array.from(b).map(x => A[x % A.length]).join(''); pwMeter();
}
function togglePw(id, btn) {
  const el = $('#' + id);
  el.type = el.type === 'password' ? 'text' : 'password';
  btn.textContent = el.type === 'password' ? '👁' : '🙈';
}

async function saveWifi() {
  const ssid = $('#wSsid').value.trim();
  const pass = $('#wPass').value.trim();
  if (!ssid && !pass) return toast('أدخل اسماً أو كلمة مرور', 'bad');
  if (pass && pass.length < 8) return toast('كلمة المرور 8 أحرف على الأقل', 'bad');
  try {
    await ROUTER.wifiSet({ ssid, password: pass, band: $('#wBand').value });
    pushLog('wifi', 'تغيير إعدادات الواي فاي: ' + (ssid || '—'));
    toast('تم الحفظ والتطبيق ✅', 'ok');
    $('#wPass').value = '';
    renderWifi();
  } catch (e) { toast('تعذّر التطبيق: ' + e.message, 'bad'); }
}

async function rollWifi() {
  const pass = randStr(14);
  $('#wSsid').value = 'WiFi-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  $('#wPass').value = pass; pwMeter();
  if (!confirm('سيُقطع اتصال جميع الأجهزة momentarily. متابعة؟')) return;
  try {
    await ROUTER.wifiSet({ ssid: $('#wSsid').value, password: pass, band: 'both' });
    pushLog('wifi', 'تدوير الشبكة');
    toast('تم تدوير الشبكة', 'ok');
  } catch (e) { toast(e.message, 'bad'); }
}
function randStr(n) { return randomPassword(n); }

/* ============================ الاشتراك ============================ */
function renderSub() {
  const box = $('#mySub');
  if (ME.role === 'admin') {
    box.innerHTML = `<div class="kv"><span>أنت مدير النظام</span><b>كل الصلاحيات مفعّلة</b></div>`;
  } else if (ME.sub) {
    const plan = CFG.plan(ME.sub.plan);
    box.innerHTML = `
      <div class="kv"><span>الباقة</span><b>${esc(plan ? plan.label : ME.sub.plan)}</b></div>
      <div class="kv"><span>الحالة</span><b>${ME.active ? '<span class="pill p-ok">مفعّل</span>' : '<span class="pill p-bad">منتهي</span>'}</b></div>
      <div class="kv"><span>ينتهي في</span><b>${fmtDate(ME.sub.end)} (${daysLeft(ME.sub.end)} يوم)</b></div>
      <div class="kv"><span>عدد الأجهزة المسموح</span><b>${ME.sub.maxDev || 3}</b></div>
      <div class="kv"><span>أجهزتي</span><b>${(ME.sub.devices || []).length}</b></div>`;
  } else if (store.get('pendingSub', null) || (CFG.requests || []).some(r => r.username === ME.username && (!r.status || r.status === 'pending'))) {
    box.innerHTML = `<div class="kv"><span>الحالة</span><b><span class="pill p-warn">قيد المراجعة عند المشرف</span></b></div>
      <div class="dim small" style="line-height:1.9;margin-top:8px">طلبك مسجَّل. فور اعتماده من لوحة الإدارة تُفتح كل المميزات تلقائياً في هذه الشاشة — دون أي إجراء منك.</div>
      <button class="btn sm" style="margin-top:10px" onclick="refreshSubscription()">↻ تحديث الحالة</button>`;
  } else {
    box.innerHTML = `<div class="dim small" style="line-height:1.9">لا يوجد اشتراك مفعّل بعد. اطلب الباقة أو أدخل الكود — بعد موافقة المشرف تُفتح كل المميزات تلقائياً.</div>`;
  }
  $('#plansBox').innerHTML = CFG.plans.map(p => `
    <div class="pc">
      <b>${esc(p.label)}</b>
      <div class="price">${esc(p.price)} <small>${esc((CFG.data.app && CFG.data.app.currency) || '')}</small></div>
      <div class="dim small">${p.days} يوم · حتى ${p.maxDev} أجهزة</div>
      <button class="btn wa blk" style="margin-top:10px" onclick="waRequest('${p.id}')">📲 اطلب هذه الباقة</button>
    </div>`).join('');
}

function openRedeem() {
  openModal(`
    <h3 style="margin-bottom:10px">🎟️ تفعيل كود</h3>
    <input id="rdCode" placeholder="WH-XXXXX-XXXXX" style="direction:ltr;text-align:center">
    <div class="err" id="rdErr"></div>
    <button id="btnRedeem" class="btn p blk" style="margin-top:12px" onclick="doRedeem()">تفعيل</button>`);
}

async function doRedeem() {
  hideErr('#rdErr');
  const code = $('#rdCode').value.trim().toUpperCase();
  if (!code) return showErr('#rdErr', 'أدخل الكود');
  /* تحديث قائمة الأكواد من GitHub قبل التحقق */
  try { await refreshSubscription(); } catch (e) {}
  const c = CFG.codes.find(x => String(x.code).toUpperCase() === code);
  if (!c) return showErr('#rdErr', 'الكود غير صالح');
  if (c.usedBy && c.usedBy !== ME.username) return showErr('#rdErr', 'هذا الكود مُستخدم مسبقاً');
  if (c.expiresAt && c.expiresAt < now()) return showErr('#rdErr', 'انتهت صلاحية الكود');
  const plan = CFG.plan(c.plan);
  if (!plan) return showErr('#rdErr', 'باقة غير معروفة');

  /* تفعيل فوري: الكود الصحيح = تحويل من مجاني إلى بريميوم مباشرة */
  const base = (ME.sub && ME.sub.end && ME.sub.end > now()) ? ME.sub.end : now();
  ME.sub = {
    username: ME.username, plan: plan.id, start: now(),
    end: base + plan.days * 864e5, maxDev: c.maxDev || plan.maxDev, devices: []
  };
  ME.active = true;
  store.del('pendingSub');
  store.set('localSub', ME.sub);
  closeModal();
  toast(`تم تفعيل باقة «${plan.label}» — ${plan.days} يوم ✅`, 'ok');
  renderSub(); renderDash(); renderDevices(); renderWifi();
  /* تسجيل مركزي في hub.json (يوسم الكود كمستخدم ويضيف المشترك لمديرك) */
  await sendRequest('redeem', code, plan.id);
  setTimeout(async () => { await refreshSubscription(); }, 8000);
}

/* تحديث حالة الاشتراك من ملف الإعدادات على GitHub */
async function refreshSubscription() {
  try {
    CFG = await Config.load(CFG.url, CFG.token || store.get('cfg.token', ''));
  } catch (e) { return; }
  if (ME.role !== 'user') return;
  const sub = CFG.subscribers.find(s => String(s.username).toLowerCase() === ME.username.toLowerCase());
  const was = ME.active;
  ME.sub = sub || null;
  ME.active = !!(sub && sub.end > now());
  if (ME.active && !was) {
    store.del('pendingSub');
    toast('تم تفعيل اشتراكك — كل المميزات مفتوحة الآن 🎉', 'ok');
  }
  if (SECTION === 'dash') renderDash();
  if (SECTION === 'sub') renderSub();
  if (SECTION === 'dev') renderDevices();
}

function waRequest(planId) {
  const wa = (CFG.data.app && CFG.data.app.whatsapp) || '963957869853';
  const plan = CFG.plan(planId);
  const label = plan ? plan.label : 'اختيار من التطبيق';
  const date = new Date().toLocaleDateString('ar');
  const msg = encodeURIComponent(
    `*طلب اشتراك WiFi Hub*\n` +
    `━━━━━━━━━━━━━━━\n` +
    `📦 *الباقة:* ${label}\n` +
    `👤 *الاسم:* ${ME.username}\n` +
    `📅 *التاريخ:* ${date}\n` +
    `━━━━━━━━━━━━━━━\n` +
    `أرسل لي كود التفعيل وسأدخله في البرنامج.`
  );
  window.open(`https://wa.me/${String(wa).replace(/\D/g, '')}?text=${msg}`, '_blank');
}

/* إرسال طلب للمدير عبر GitHub Issues (يعمل تلقائياً) أو واتساب */
async function sendRequest(kind, code, planId, extra) {
  const plan = planId || (ME.sub ? ME.sub.plan : null) || (store.get('pendingSub', {}) || {}).plan || null;
  const req = Object.assign({ username: ME.username, plan, code: code || '', at: now(), kind }, extra || {});
  const token = (BUILD.requestToken || store.get('gh.requestToken', '')).trim();
  const repo = ACC.parseRepo(CFG.url);
  if (!token || !repo) {
    if (kind === 'router-password') toast('تم التغيير على هذا الجهاز فقط — أبلغ الإدارة لتحديث كلمة المرور المشتركة', 'bad');
    return false;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/issues`, {
      method: 'POST',
      headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `[طلب اشتراك] ${ME.username} — ${kind}`,
        body: JSON.stringify(req, null, 2),
        labels: ['subscription-request']
      })
    });
    if (res.ok) { toast('تم إرسال طلبك للمشرف', 'ok'); return true; }
    else toast('تعذّر إرسال الطلب — أبلغ الإدارة مباشرة', 'bad');
  } catch (e) { toast('تعذّر إرسال الطلب — أبلغ الإدارة مباشرة', 'bad'); }
  return false;
}

async function saveRouterPass() {
  const np = $('#rNewPass').value.trim();
  if (!np || np.length < 5) return toast('كلمة المرور قصيرة (5 أحرف على الأقل)', 'bad');
  if (!confirm('سيتم تغيير كلمة مرور حساب الراوتر فوراً. هل أنت متأكد؟')) return;
  try {
    const r = await ROUTER.setAdminPassword(np, CFG.router.username || 'root');
    CFG.router.password = np;
    store.set('cfg.routerPass', np);
    pushLog('router', 'تغيير كلمة مرور الراوتر');
    toast(r.verified ? 'تم تغيير كلمة المرور وتأكيدها ✅' : 'تم التغيير', 'ok');
    $('#rNewPass').value = '';
    /* مزامنة كلمة المرور الجديدة مع ملف الإعدادات على GitHub */
    let synced = false;
    if (ACC.writeToken) {
      try {
        const { data } = await ACC.readFile();
        data.router = Object.assign({}, data.router, { password: np });
        await ACC.writeFile(data);
        synced = true;
      } catch (e) {}
    }
    if (!synced) {
      /* تمريرها للتدفق التلقائي على GitHub (يحدّث hub.json) */
      await sendRequest('router-password', '', null, { newPassword: np });
    }
    toast(synced ? 'حُدّث ملف الإعدادات على GitHub' : 'تم التغيير على الراوتر', 'ok');
  } catch (e) { toast('تعذّر التغيير: ' + e.message, 'bad'); }
}

/* ============================ الإدارة ============================ */
async function renderAdmin() {
  /* الطلبات: من Issues */
  const reqs = [];
  const repo = ACC.parseRepo(CFG.url);
  if (repo && ACC.writeToken) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/issues?state=open&labels=subscription-request`, {
        headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + ACC.writeToken }
      });
      if (res.ok) {
        const arr = await res.json();
        for (const it of arr) {
          let body = {};
          try { body = JSON.parse(it.body || '{}'); } catch (e) { body = { username: it.title }; }
          reqs.push({ id: it.id, number: it.number, username: body.username || '', plan: body.plan, code: body.code, at: new Date(it.created_at).getTime() });
        }
      }
    } catch (e) {}
  }
  /* الطلبات المحفوظة داخل hub.json (يكتبها التدفق التلقائي على GitHub) */
  for (const r of CFG.requests || []) {
    if (r.status && r.status !== 'pending') continue;
    if (!reqs.some(x => x.username === r.username)) {
      reqs.push({ id: "'" + r.id + "'", number: null, username: r.username || '', plan: r.plan, code: r.code || '', at: r.at || 0 });
    }
  }
  $('#tblReq').innerHTML = `<thead><tr><th>الاسم</th><th>الباقة</th><th>الوقت</th><th>إجراء</th></tr></thead><tbody>` +
    (reqs.length ? reqs.map(r => `<tr><td>${esc(r.username)}</td><td>${esc(CFG.plan(r.plan) ? CFG.plan(r.plan).label : '—')}</td>
      <td>${relTime(r.at)}</td><td><button class="btn sm p" onclick="approveReq(${r.id},'${esc(r.username)}','${r.plan || ''}','${r.code || ''}')">✅ تفعيل</button>
      <button class="btn sm d" onclick="closeReq(${r.id})">✕</button></td></tr>`).join('')
      : `<tr><td colspan="4" class="center dim" style="padding:22px">لا توجد طلبات</td></tr>`) + '</tbody>';

  /* المشتركون */
  renderSubs();
  /* الأكواد */
  const planSel = $('#codePlan');
  if (!planSel.options.length) planSel.innerHTML = CFG.plans.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  $('#tblCodes').innerHTML = `<thead><tr><th>الكود</th><th>الباقة</th><th>الأجهزة</th><th>الحالة</th><th></th></tr></thead><tbody>` +
    (CFG.codes.length ? CFG.codes.map(c => `<tr><td class="mono">${esc(c.code)}</td><td>${esc(CFG.plan(c.plan) ? CFG.plan(c.plan).label : c.plan)}</td>
      <td>${c.maxDev || 3}</td><td>${c.usedBy ? '<span class="pill p-info">مستخدم: ' + esc(c.usedBy) + '</span>' : '<span class="pill p-ok">متاح</span>'}</td>
      <td><button class="btn sm d" onclick="delCode('${esc(c.code)}')">حذف</button></td></tr>`).join('')
      : `<tr><td colspan="5" class="center dim" style="padding:22px">لا توجد أكواد</td></tr>`) + '</tbody>';

  /* إعدادات */
  $('#admUser').value = (CFG.data.app && CFG.data.app.admin && CFG.data.app.admin.username) || 'admin';
  $('#rBase').value = CFG.router.base || '';
  $('#rUser').value = CFG.router.username || 'root';
  $('#rPass').value = CFG.router.password || '';
  $('#rWa').value = (CFG.data.app && CFG.data.app.whatsapp) || '';
  $('#rAdminPass').value = (CFG.data.app && CFG.data.app.adminPass) || 'admin';
  $('#rAuto').value = (CFG.settings.autoApprove ? '1' : '0');
}

function renderSubs() {
  const q = ($('#fUser').value || '').toLowerCase();
  /* المستخدمون الأحرار المسجَّلون + المفعّلون، في جدول واحد */
  const freeUsers = (CFG.data.users || []).filter(u => !CFG.subscribers.some(s => s.username === u.username));
  const allUsers = freeUsers.concat(CFG.subscribers);
  const subs = allUsers.filter(s => !q || String(s.username).toLowerCase().includes(q));
  const isPrem = s => !!(s.end && s.end > now());
  $('#tblSubs').innerHTML = `<thead><tr><th>الاسم</th><th>الحالة</th><th>الباقة</th><th>ينتهي</th><th>المتبقي</th><th>الأجهزة</th><th>الكود</th><th>إجراءات</th></tr></thead><tbody>` +
    (subs.length ? subs.map(s => {
      const prem = isPrem(s);
      const pl = CFG.plan(s.plan);
      const code = (CFG.codes || []).find(c => c.usedBy === s.username);
      return `<tr><td><b>${esc(s.username)}</b></td>
      <td>${prem ? '<span class="pill p-ok">بريميوم</span>' : '<span class="pill p-muted">مجاني</span>'}</td>
      <td>${esc(pl ? pl.label : s.plan || '—')}</td>
      <td>${s.end ? fmtDate(s.end) : '—'}</td>
      <td>${prem ? '<span class="pill p-warn">' + daysLeft(s.end) + ' يوم</span>' : '—'}</td>
      <td>${(s.devices || []).length}/${s.maxDev || (pl ? pl.maxDev : 3)}</td>
      <td class="mono">${esc(code ? code.code : '—')}</td>
      <td style="white-space:normal">${prem ? `
        <button class="btn sm" onclick="extendSub('${esc(s.username)}',30)">+30 يوم</button>
        <button class="btn sm w" onclick="extendSub('${esc(s.username)}',90)">+90 يوم</button>
        <button class="btn sm d" onclick="delSub('${esc(s.username)}')">حذف</button>`
        : `<button class="btn sm p" onclick="promoteFree('${esc(s.username)}')">✅ تفعيل باقة</button>`}</td></tr>`;
    }).join('')
      : `<tr><td colspan="8" class="center dim" style="padding:22px">لا يوجد مشتركون بعد — ستظهر هنا فور تفعيل أول اشتراك</td></tr>`) + '</tbody>';

  /* طلبات الانتظار (مستخدمون مجانيون لم يُفعَّل اشتراكهم بعد) */
  const pend = (CFG.requests || []).filter(r => !r.status || r.status === 'pending');
  $('#tblFree').innerHTML = `<thead><tr><th>الاسم</th><th>الباقة المطلوبة</th><th>الوقت</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>` +
    (pend.length ? pend.map(r => `<tr><td><b>${esc(r.username)}</b></td>
      <td>${esc(CFG.plan(r.plan) ? CFG.plan(r.plan).label : r.plan || '—')}</td>
      <td>${r.at ? relTime(r.at) : '—'}</td>
      <td><span class="pill p-muted">مجاني</span></td>
      <td><button class="btn sm p" onclick="approveReq('${esc(r.id)}','${esc(r.username)}','${esc(r.plan || '')}','${esc(r.code || '')}')">✅ تفعيل</button></td></tr>`).join('')
      : `<tr><td colspan="5" class="center dim" style="padding:22px">لا توجد طلبات معلّقة</td></tr>`) + '</tbody>';
}

/* كتابة على GitHub */
async function writeHub(mutator) {
  try {
    const { data } = await ACC.readFile();
    const res = await mutator(data);
    await ACC.writeFile(data);
    CFG = await Config.load(CFG.url, CFG.token || store.get('cfg.token', ''));
    toast(res || 'تم الحفظ على GitHub', 'ok');
    await renderAdmin();
    return true;
  } catch (e) { toast(e.message, 'bad'); return false; }
}

async function approveReq(id, username, plan, code) {
  const p = plan || (CFG.codes.find(c => c.code === code) || {}).plan;
  const pl = CFG.plan(p);
  if (!pl) return toast('الباقة غير معروفة', 'bad');
  const okWrite = await writeHub(async data => {
    data.subscribers = data.subscribers || [];
    data.requests = data.requests || [];
    const ex = data.subscribers.find(s => s.username === username);
    const rec = ex || { id: 'u' + now().toString(36), username, devices: [], created: now() };
    rec.plan = pl.id; rec.start = now(); rec.end = now() + pl.days * 864e5; rec.maxDev = pl.maxDev;
    if (!ex) data.subscribers.push(rec);
    if (code) { const c = (data.codes || []).find(x => x.code === code); if (c) { c.usedBy = username; c.usedAt = now(); } }
    for (const r of data.requests) if (r.username === username) r.status = 'approved';
    return 'تم تفعيل اشتراك ' + username;
  });
  if (okWrite && /^[0-9]+$/.test(String(id))) await closeIssue(id);
}

async function closeReq(id) {
  await writeHub(async data => {
    data.requests = data.requests || [];
    for (const r of data.requests) if (r.id === id) r.status = 'rejected';
    return 'تم رفض الطلب';
  });
}

async function closeIssue(id) {
  const repo = ACC.parseRepo(CFG.url);
  if (!repo || !ACC.writeToken || !/^[0-9]+$/.test(String(id))) return;
  try {
    await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/issues/${id}`, {
      method: 'PATCH',
      headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + ACC.writeToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'closed' })
    });
  } catch (e) {}
}

async function extendSub(username, days) {
  await writeHub(async data => {
    const s = (data.subscribers || []).find(x => x.username === username);
    if (!s) return 'غير موجود';
    s.end = Math.max(now(), s.end || now()) + days * 864e5;
    return 'تم تمديد ' + username;
  });
}

/* تفعيل باقة لمستخدم مجاني من لوحة الإدارة */
async function promoteFree(username) {
  const plan = CFG.plans[0];
  if (!plan) return toast('لا توجد باقات معرَّفة', 'bad');
  const pick = prompt('أيام الباقة للمستخدم ' + username + ':', String(plan.days));
  if (pick === null) return;
  const days = +pick || plan.days;
  await writeHub(async data => {
    data.subscribers = data.subscribers || [];
    const rec = data.subscribers.find(x => x.username === username) || {
      id: 'u' + now().toString(36), username, devices: [], created: now()
    };
    rec.plan = plan.id;
    rec.start = now();
    rec.end = now() + days * 864e5;
    rec.maxDev = plan.maxDev;
    if (!data.subscribers.includes(rec)) data.subscribers.push(rec);
    for (const r of (data.requests || [])) if (r.username === username) r.status = 'approved';
    return 'تم تفعيل اشتراك ' + username;
  });
}

async function delSub(username) {
  if (!confirm('حذف المشترك ' + username + '؟')) return;
  await writeHub(async data => {
    data.subscribers = (data.subscribers || []).filter(x => x.username !== username);
    return 'تم الحذف';
  });
}

async function genCodes() {
  const plan = $('#codePlan').value, maxDev = +$('#codeMaxDev').value || 3;
  const qty = +$('#codeQty').value || 1;
  const exp = $('#codeExp').value;
  const expiresAt = exp ? new Date(exp + 'T23:59:59').getTime() : 0;
  const made = [];
  /* توليد محلي فوري (يظهر دائماً) + محاولة الحفظ على GitHub */
  for (let i = 0; i < qty; i++) {
    let code;
    do { code = randomCode(); } while (made.includes(code) || (CFG.codes || []).some(c => c.code === code));
    made.push(code);
  }
  let saved = false;
  try {
    const { data } = await ACC.readFile();
    data.codes = data.codes || [];
    for (const code of made) {
      data.codes.unshift({
        code, plan, maxDev, price: (CFG.plan(plan) || {}).price || 0,
        created: now(), expiresAt, usedBy: '', usedAt: 0
      });
    }
    await ACC.writeFile(data);
    saved = true;
    toast(`تم توليد ${qty} كود وحفظها على GitHub`, 'ok');
  } catch (e) {
    store.set('pendingCodes', made.concat(store.get('pendingCodes', [])));
    toast('تم التوليد محلياً فقط — أضف توكن الكتابة لحفظها على GitHub', 'bad');
  }
  $('#newCodes').innerHTML = `<div class="code">${made.join('<br>')}</div>`;
  $('#btnCopyAll').classList.remove('hide');
  $('#btnDlCodes').classList.remove('hide');
  $('#newCodes').dataset.codes = made.join(',');
}

function copyAllCodes() {
  const t = $('#newCodes').dataset.codes || '';
  navigator.clipboard.writeText(t.replace(/,/g, '\n')).then(() => toast('تم النسخ', 'ok'));
}
function downloadCodes() {
  const t = ($('#newCodes').dataset.codes || '').split(',');
  const csv = 'code\n' + t.join('\n');
  const b = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = 'wifihub-codes.csv'; a.click();
}

async function delCode(code) {
  if (!confirm('حذف الكود ' + code + '؟')) return;
  await writeHub(async data => {
    data.codes = (data.codes || []).filter(c => c.code !== code);
    return 'تم حذف الكود';
  });
}

async function saveRouterCfg() {
  const app = (CFG.data.app = CFG.data.app || {});
  app.whatsapp = $('#rWa').value.trim();
  app.adminPass = $('#rAdminPass').value || 'admin';
  CFG.router.base = $('#rBase').value.trim();
  CFG.router.username = $('#rUser').value.trim() || 'root';
  CFG.router.password = $('#rPass').value;
  CFG.settings.autoApprove = $('#rAuto').value === '1';
  await writeHub(async data => { data.router = CFG.router; data.app = app; data.settings = CFG.settings; return 'تم حفظ الإعدادات'; });
  ROUTER.cfg = CFG.router;
}

async function rebootRouter() {
  if (!confirm('إعادة تشغيل الراوتر؟')) return;
  try { await ROUTER.reboot(); toast('تم إرسال أمر إعادة التشغيل', 'ok'); }
  catch (e) { toast(e.message, 'bad'); }
}

async function syncNow() {
  try { CFG = await Config.load(CFG.url, CFG.token || store.get('cfg.token', '')); toast('تمت المزامنة', 'ok'); renderAdmin(); renderSub(); }
  catch (e) { toast(e.message, 'bad'); }
}

/* ============================ متنوّع ============================ */
function pushLog(type, txt) {
  LOG.unshift({ t: now(), type, txt });
  LOG = LOG.slice(0, 60);
  store.set('log', LOG);
}
function showErr(sel, msg) { const e = $(sel); e.textContent = msg; e.style.display = 'block'; }
function hideErr(sel) { const e = $(sel); if (e) e.style.display = 'none'; }

function openModal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.add('on'); }
function closeModal() { $('#modal').classList.remove('on'); }

function applyTheme() {
  const t = store.get('theme', 'dark');
  document.documentElement.setAttribute('data-theme', t);
}
function toggleTheme() {
  const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  store.set('theme', t);
}

/* تحديث دوري من GitHub + فك التجميد المنتهي */
function startPolling() {
  const sec = CFG.settings.pollSeconds || 30;
  setInterval(async () => {
    if (document.hidden) return;
    await refreshSubscription();
    await unfreezeExpired();
  }, sec * 1000);
  /* تحديث فوري عند عودة التطبيق للواجهة */
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSubscription(); });
  window.addEventListener('focus', () => refreshSubscription());
}

/* واجهة عامة للوظائف المستدعاة من HTML */
globalThis.showSection = showSection;
globalThis.authTab = authTab;
globalThis.saveSetup = saveSetup;
globalThis.doLogin = doLogin;
globalThis.doRegister = doRegister;
globalThis.doAdminLogin = doAdminLogin;
globalThis.doLogout = doLogout;
globalThis.refreshAll = refreshAll;
globalThis.renderDevices = renderDevices;
globalThis.renderSubs = renderSubs;
globalThis.doFreeze = doFreeze;
globalThis.doBlock = doBlock;
globalThis.doRename = doRename;
globalThis.saveWifi = saveWifi;
globalThis.rollWifi = rollWifi;
globalThis.randPass = randPass;
globalThis.togglePw = togglePw;
globalThis.pwMeter = pwMeter;
globalThis.openRedeem = openRedeem;
globalThis.doRedeem = doRedeem;
globalThis.waRequest = waRequest;
globalThis.genCodes = genCodes;
globalThis.copyAllCodes = copyAllCodes;
globalThis.downloadCodes = downloadCodes;
globalThis.delCode = delCode;
globalThis.approveReq = approveReq;
globalThis.closeReq = closeReq;
globalThis.refreshSubscription = refreshSubscription;
globalThis.saveAdminCreds = saveAdminCreds;
globalThis.extendSub = extendSub;
globalThis.delSub = delSub;
globalThis.promoteFree = promoteFree;
globalThis.saveRouterCfg = saveRouterCfg;
globalThis.rebootRouter = rebootRouter;
globalThis.syncNow = syncNow;
globalThis.saveRouterPass = saveRouterPass;
globalThis.openModal = openModal;
globalThis.closeModal = closeModal;
globalThis.toggleTheme = toggleTheme;

boot();
