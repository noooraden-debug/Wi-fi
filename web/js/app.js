/* WiFi Hub — منطق التطبيق (مربوط بالخادم الداخلي + الراوتر مباشرة)
 *
 * • الحسابات والأكواد والاشتراكات: قاعدة بيانات الخادم الداخلي (REST + SSE لحظي).
 * • التحكم بالأجهزة والواي فاي: اتصال مباشر بالراوتر (ubus) من داخل الجهاز.
 */

import { $, $$, esc, fmtBytes, fmtDate, fmtDateTime, daysLeft, relTime, store, toast, sleep, now, randomPassword } from './util.js';
import { api, getToken, setToken, getSavedUser, setSavedUser, openStream, closeStream, API_BASE } from './api.js';
import { Router } from './router.js';

let CFG = null, ROUTER = null, ME = null, DEVICES = [], SECTION = 'dash';
let FREEZES = store.get('freezes', {});
let LOG = store.get('log', []);
let REMEMBER = false;

/* ============================ الإقلاع ============================ */
async function boot() {
  applyTheme();
  try {
    CFG = await api.get('/api/public/config');
  } catch (e) {
    $('#setupBox').classList.remove('hide');
    $('#loginBox').classList.add('hide');
    showErr('#setupErr', e.message);
    $('#setupFoot').textContent = '';
    return;
  }
  $('#appTitle').textContent = (CFG.app && CFG.app.name) || 'WiFi Hub';
  $('#appOwner').textContent = (CFG.app && CFG.app.owner) ? CFG.app.owner : 'تحكّم بشبكتك واشتراكك';
  const aEl = $('#aUser'); if (aEl && !aEl.value) aEl.value = CFG.adminUsername || 'boss';
  $('#setupFoot').textContent = API_BASE ? '✔ متصل بالخادم: ' + API_BASE : '✔ متصل بالخادم الداخلي';
  $('#loginBox').classList.remove('hide');
  $('#setupBox').classList.add('hide');

  /* استعادة جلسة محفوظة (تذكّرني) */
  const saved = getSavedUser();
  if (saved && getToken()) {
    try { await enterApp(saved, false); } catch (e) { setToken(null); setSavedUser(null); }
  }
}

/* ============================ الدخول ============================ */
function authTab(t) {
  ['login', 'reg', 'admin'].forEach(x => $('#pane' + x[0].toUpperCase() + x.slice(1)).classList.toggle('hide', t !== x));
  $('#tabLogin').classList.toggle('on', t === 'login');
  $('#tabReg').classList.toggle('on', t === 'reg');
  $('#tabAdmin').classList.toggle('on', t === 'admin');
  hideErr('#lErr'); hideErr('#rErr'); hideErr('#aErr');
}

async function doLogin() {
  hideErr('#lErr');
  const username = $('#lUser').value.trim(), pass = $('#lPass').value;
  if (!username || !pass) return showErr('#lErr', 'أدخل اسم المستخدم وكلمة المرور');
  await authenticate(username, pass, $('#lRemember').checked, '#lErr');
}

async function doRegister() {
  hideErr('#rErr');
  const username = $('#rUser').value.trim(), p1 = $('#rPass').value, p2 = $('#rPass2').value;
  if (username.length < 3) return showErr('#rErr', 'اسم المستخدم 3 أحرف على الأقل');
  if (p1.length < 4) return showErr('#rErr', 'كلمة المرور 4 أحرف على الأقل');
  if (p1 !== p2) return showErr('#rErr', 'كلمتا المرور غير متطابقتين');
  try {
    const r = await api.post('/api/auth/register', { username, password: p1, remember: $('#rRemember') ? $('#rRemember').checked : true });
    REMEMBER = $('#rRemember') ? $('#rRemember').checked : true;
    setToken(r.token, REMEMBER);
    setSavedUser(r.user, REMEMBER);
    await enterApp(r.user, true);
    toast('تم إنشاء حسابك — يمكنك طلب باقة الآن', 'ok');
  } catch (e) { showErr('#rErr', e.message); }
}

async function doAdminLogin() {
  hideErr('#aErr');
  const username = ($('#aUser').value || '').trim() || 'boss';
  const pass = $('#aPass').value;
  if (!pass) return showErr('#aErr', 'أدخل كلمة مرور الإدارة');
  await authenticate(username, pass, $('#aRemember') ? $('#aRemember').checked : true, '#aErr');
}

async function authenticate(username, pass, remember, errSel) {
  try {
    const r = await api.post('/api/auth/login', { username, password: pass, remember });
    REMEMBER = !!remember;
    setToken(r.token, REMEMBER);
    setSavedUser(r.user, REMEMBER);
    await enterApp(r.user, true);
    if (r.user.role === 'admin') toast('مرحباً بك في لوحة الإدارة 👑', 'ok');
    else toast('أهلاً بك ' + r.user.username, 'ok');
  } catch (e) { showErr(errSel, e.message); }
}

async function doLogout() {
  try { await api.post('/api/auth/logout'); } catch (e) {}
  setToken(null); setSavedUser(null);
  closeStream();
  ME = null;
  location.reload();
}

/* ============================ الدخول إلى التطبيق ============================ */
async function enterApp(user, fresh) {
  ME = user;
  if (fresh) {
    /* تأكيد الحالة من الخادم دائماً (الأيام المتبقية، حالة البريميوم) */
    const r = await api.get('/api/me');
    ME = r.user;
  }
  ME.active = ME.premium || ME.role === 'admin';
  ME.sub = ME.subEnd ? { plan: ME.plan, end: ME.subEnd, maxDev: ME.maxDev } : null;
  $('#authView').classList.add('hide');
  $('#appView').classList.remove('hide');
  $('#whoName').textContent = ME.role === 'admin' ? 'مدير النظام' : ME.username;
  $('#whoRole').innerHTML = ME.role === 'admin'
    ? '<span class="pill p-warn">👑 لوحة الإدارة</span>'
    : (ME.active ? '<span class="pill p-ok">⭐ بريميوم</span>' : '<span class="pill p-info">مشترك مجاني</span>');
  buildNav();
  await showSection('dash');
  if (ME.router) {
    ROUTER = new Router(ME.router);
    connectRouter();
  } else {
    $('#netChip').className = 'pill p-muted';
    $('#netChip').textContent = '🔒 مقفل — اشتراك غير مفعّل';
  }
  startStream();
}

/* ---------- المزامنة اللحظية ---------- */
let POLL_TIMER = null, LAST_SIG = '';

function startStream() {
  openStream(async ev => {
    if (!ME) return;
    if (ev.type === 'subscription.activated' && ev.username === ME.username) {
      const r = await api.get('/api/me');
      ME = r.user; ME.active = ME.premium; ME.sub = ME.subEnd ? { plan: ME.plan, end: ME.subEnd, maxDev: ME.maxDev } : null;
      store.del('pendingSub');
      toast('تم تفعيل اشتراكك — كل المميزات مفتوحة الآن 🎉', 'ok');
      if (ME.router && !ROUTER) { ROUTER = new Router(ME.router); connectRouter(); }
      renderAll();
      return;
    }
    if (ev.type === 'subscription.activated' && ME.role === 'user') {
      const r = await api.get('/api/me');
      ME = r.user; ME.active = ME.premium; ME.sub = ME.subEnd ? { plan: ME.plan, end: ME.subEnd, maxDev: ME.maxDev } : null;
      renderAll();
      return;
    }
    if (ME.role === 'admin' && ['subscribers.changed', 'codes.changed', 'requests.changed', 'users.changed', 'settings.changed'].includes(ev.type)) {
      await renderAdmin();
      toast('⟳ حُدّثت اللوحة لحظياً', '');
      return;
    }
    if (ME.role === 'user' && ['subscribers.changed', 'settings.changed'].includes(ev.type)) {
      const r = await api.get('/api/me');
      const was = ME.active;
      ME = r.user; ME.active = ME.premium; ME.sub = ME.subEnd ? { plan: ME.plan, end: ME.subEnd, maxDev: ME.maxDev } : null;
      if (!was && ME.active) { toast('تم تفعيل اشتراكك — كل المميزات مفتوحة الآن 🎉', 'ok'); if (ME.router) { ROUTER = new Router(ME.router); connectRouter(); } }
      renderAll();
    }
  });

  /* شبكة أمان: استطلاع خفيف كل 10 ثوانٍ لو انقطع البث اللحظي */
  if (POLL_TIMER) clearInterval(POLL_TIMER);
  POLL_TIMER = setInterval(async () => {
    if (!ME || document.hidden) return;
    try {
      if (ME.role === 'admin') {
        const d = await api.get('/api/admin/overview');
        const sig = JSON.stringify([d.stats, d.codes.length, d.requests.length, d.subscribers.map(x => [x.username, x.status, x.daysLeft])]);
        if (sig !== LAST_SIG) { LAST_SIG = sig; if (SECTION === 'admin') renderAdmin(); else renderDash(); }
      } else {
        const r = await api.get('/api/me');
        const was = ME.active;
        ME = r.user; ME.active = ME.premium;
        ME.sub = ME.subEnd ? { plan: ME.plan, end: ME.subEnd, maxDev: ME.maxDev } : null;
        if (!was && ME.active) {
          toast('تم تفعيل اشتراكك — كل المميزات مفتوحة الآن 🎉', 'ok');
          if (ME.router && !ROUTER) { ROUTER = new Router(ME.router); connectRouter(); }
        }
        renderAll();
      }
    } catch (e) {}
  }, 10000);
}

function renderAll() {
  buildNav();
  if (SECTION === 'dash') renderDash();
  if (SECTION === 'dev') renderDevices();
  if (SECTION === 'wifi') renderWifi();
  if (SECTION === 'sub') renderSub();
  if (SECTION === 'admin') renderAdmin();
}

/* ============================ التنقل ============================ */
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
  if (!ROUTER) return;
  const chip = $('#netChip');
  chip.className = 'pill p-warn'; chip.textContent = '🔌 جارٍ الاتصال بالراوتر';
  try {
    await ROUTER.connect();
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
  if (!ROUTER) return;
  if (!ROUTER.connected) { await connectRouter(); return; }
  try {
    DEVICES = await ROUTER.clients();
    const chip = $('#netChip');
    chip.className = 'pill p-ok'; chip.textContent = '🔌 متصل (' + DEVICES.length + ' جهاز)';
    await reportDevices();
  } catch (e) {
    toast('تعذّر جلب الأجهزة: ' + e.message, 'bad');
  }
  if (SECTION === 'dash') renderDash();
  if (SECTION === 'dev') renderDevices();
}

/* إرسال قائمة الأجهزة للخادم (ليظهر للمشترك في لوح الإدارة) */
async function reportDevices() {
  if (!ME || ME.role === 'admin') return;
  try {
    await api.post('/api/me/devices', {
      devices: DEVICES.slice(0, 100).map(d => ({
        mac: d.mac, name: d.name || '', ip: d.ip || '',
        usage: d.usage || 0, online: !!d.online
      }))
    });
  } catch (e) {}
}

/* حالة الحظر/التجميد */
let BLOCKED = new Set();
async function loadBlocks() {
  BLOCKED = new Set();
  if (!ROUTER) return;
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
      try { if (ROUTER) await ROUTER.unblockDevice(k); } catch (e) {}
    }
  }
  store.set('freezes', FREEZES);
}

/* ============================ العرض ============================ */
function isPremium() { return !!(ME && (ME.role === 'admin' || ME.active)); }
function myDaysLeft() {
  if (!ME || !ME.subEnd) return 0;
  return Math.max(0, Math.ceil((Number(ME.subEnd) - Date.now()) / 864e5));
}
function deviceState(d) {
  if (isBlocked(d.mac)) return { t: 'محظور', c: 'p-bad' };
  if (isFrozen(d.mac)) return { t: 'مجمّد', c: 'p-warn' };
  if (d.online) return { t: 'متصل', c: 'p-ok' };
  return { t: 'غير متصل', c: 'p-muted' };
}
const TICON = { phone: '📱', laptop: '💻', tv: '📺', iot: '🔌', wearable: '⌚', printer: '🖨️', other: '📦' };
const TYPES = { phone: 'هاتف', laptop: 'حاسوب', tv: 'تلفاز', iot: 'جهاز ذكي', wearable: 'ساعة', printer: 'طابعة', other: 'أخرى' };
const PLANS = () => (CFG && CFG.plans) || [];

function renderDash() {
  const online = DEVICES.filter(d => d.online).length;
  const usage = DEVICES.reduce((a, d) => a + (d.usage || 0), 0);
  const st = [
    ['الأجهزة', DEVICES.length, '📱'], ['متصل الآن', online, '🟢'],
    ['الاستهلاك', fmtBytes(usage), '📊'],
    ME.role === 'admin' ? ['المشتركون', (ADMIN_DATA && ADMIN_DATA.stats) ? ADMIN_DATA.stats.premium : '—', '👥']
      : (ME.active ? ['المتبقي (يوم)', myDaysLeft(), '⏳'] : ['الباقة', 'مجاني', '🎫'])
  ];
  $('#dashStats').innerHTML = st.map(s => `<div class="card stat"><span>${s[2]} ${s[0]}</span><b>${s[1]}</b></div>`).join('');

  const b = $('#subBanner');
  if (ME.role !== 'admin' && !ME.active) {
    b.className = 'banner';
    b.innerHTML = `<span style="font-size:22px">🔒</span>
      <div style="flex:1;min-width:220px"><b>اشتراكك غير مفعّل — المميزات مقفلة</b>
      <div class="small dim">اطلب الباقة عبر واتساب أو أدخل الكود الذي وصلك. بعد التفعيل تُفتح كل المميزات تلقائياً داخل البرنامج — بلا أي إعداد خارجي.</div></div>
      <button class="btn wa" onclick="waRequest()">📲 اطلب الباقة</button>
      <button class="btn p" onclick="openRedeem()">🎟️ أدخل الكود</button>`;
    b.classList.remove('hide');
  } else if (ME.role !== 'admin') {
    b.className = 'banner ok';
    b.innerHTML = `<span style="font-size:22px">⭐</span>
      <div style="flex:1;min-width:220px"><b>اشتراكك بريميوم — كل المميزات مفتوحة</b>
      <div class="small dim">متبقٍ لك ${myDaysLeft()} يوم — تحكّم بأجهزتك وغيّر كلمة مرور الواي فاي والراوتر من هنا.</div></div>
      <span class="pill p-ok">⏳ ${myDaysLeft()} يوم</span>`;
    b.classList.remove('hide');
  } else b.classList.add('hide');

  $('#tblDash').innerHTML = deviceTable(DEVICES.slice(0, 12), false);
  renderNetState();
}

async function renderNetState() {
  const box = $('#netState');
  if (!ROUTER) { box.innerHTML = '<div class="dim small">🔒 تحكّم الراوتر متاح للمشتركين المدفوعين فقط. فعّل باقتك لتظهر حالتك هنا مباشرة.</div>'; return; }
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
  if (!isPremium()) {
    $('#tblDev').innerHTML = `<tbody><tr><td class="center" style="padding:32px">
      <div style="font-size:38px">🔒</div><b style="display:block;margin:6px 0">مزايا الاشتراك مقفلة</b>
      <div class="dim small" style="margin-bottom:12px">عرض الأجهزة وحجم بياناتها والتحكم بها (حظر · تجميد · حذف · تعليق) متاح للمشتركين المدفوعين فقط.</div>
      <button class="btn wa" onclick="waRequest()">📲 اطلب الباقة</button>
      <button class="btn p" onclick="openRedeem()">🎟️ أدخل الكود</button></td></tr></tbody>`;
    return;
  }
  $('#tblDev').innerHTML = deviceTable(rows, true);
}

function deviceTable(rows, full) {
  const maxDev = ME && ME.maxDev ? ME.maxDev : 0;
  let h = `<thead><tr><th>الجهاز</th><th>النوع</th>${full ? '<th>IP / MAC</th>' : ''}<th>الاستهلاك</th><th>الحالة</th>${full ? '<th>التحكم</th>' : ''}</tr></thead><tbody>`;
  if (!rows.length) h += `<tr><td colspan="6" class="center dim" style="padding:26px">لا توجد أجهزة مطابقة</td></tr>`;
  rows.forEach((d, i) => {
    const st = deviceState(d);
    const name = d.name || d.mac;
    const over = full && maxDev && i >= maxDev;
    h += `<tr>
      <td class="dcell"><div style="display:flex;align-items:center;gap:9px">
        <div class="avt">${TICON[d.type] || TICON.other}</div>
        <div class="nm"><div style="font-weight:700">${esc(name)}</div>
        <div class="dim small">${d.signal != null ? '📶 ' + d.signal + ' dBm' : ''} ${d.online ? 'متصل' : 'غير متصل'}</div></div></div></td>
      <td>${TYPES[d.type] || TYPES.other}</td>
      ${full ? `<td class="mono" style="direction:ltr;text-align:right">${esc(d.ip || '—')}<div class="dim small">${esc(d.mac)}</div></td>` : ''}
      <td><div style="font-weight:700">${fmtBytes(d.usage || 0)}</div></td>
      <td><span class="pill ${st.c}">${st.t}</span></td>
      ${full ? `<td style="white-space:normal">${over
          ? '<span class="pill p-warn">خارج حدود الباقة</span>'
          : `<button class="btn sm" onclick="doFreeze('${d.mac}')">❄️ ${isFrozen(d.mac) ? 'إلغاء' : 'تجميد'}</button>
             <button class="btn sm ${isBlocked(d.mac) ? 'g' : 'd'}" onclick="doBlock('${d.mac}')">🚫 ${isBlocked(d.mac) ? 'رفع الحظر' : 'حظر'}</button>
             <button class="btn sm" onclick="doKick('${d.mac}')">🗑️ حذف</button>
             <button class="btn sm" onclick="doRename('${d.mac}')">✏️ تعليق</button>`}</td>` : ''}
    </tr>`;
  });
  return h + '</tbody>';
}

/* ---------- أفعال الأجهزة ---------- */
async function doFreeze(mac) {
  if (!isPremium()) return toast('هذه الميزة للمشتركين المدفوعين', 'bad');
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
  if (!isPremium()) return toast('هذه الميزة للمشتركين المدفوعين', 'bad');
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

async function doKick(mac) {
  if (!isPremium()) return toast('هذه الميزة للمشتركين المدفوعين', 'bad');
  try {
    await ROUTER.kick(mac);
    toast('تم فصل الجهاز من الشبكة', 'ok');
    setTimeout(refreshAll, 1500);
  } catch (e) { toast(e.message, 'bad'); }
}

async function doRename(mac) {
  if (!isPremium()) return toast('هذه الميزة للمشتركين المدفوعين', 'bad');
  const d = DEVICES.find(x => x.mac === mac);
  const name = prompt('الاسم الجديد (تعليق) للجهاز:', d ? (d.name || '') : '');
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
        تغيير اسم الشبكة وكلمة المرور — وكل أدوات التحكم — متاح للمشتركين المدفوعين فقط.</div>
      <div style="display:flex;gap:9px;justify-content:center;flex-wrap:wrap">
        <button class="btn wa" onclick="waRequest()">📲 اطلب الباقة</button>
        <button class="btn p" onclick="openRedeem()">🎟️ أدخل الكود</button></div>`;
    return;
  }
  $('#wifiForm').classList.remove('hide');
  $('#wifiLocked').classList.add('hide');
  const box = $('#wifiState');
  box.innerHTML = '<div class="dim small">جارٍ القراءة…</div>';
  if (!ROUTER) { box.innerHTML = '<div class="dim small">تعذّر الاتصال بالراوتر بعد.</div>'; return; }
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
  $('#' + id).value = randomPassword(12); pwMeter();
}
function togglePw(id, btn) {
  const el = $('#' + id);
  el.type = el.type === 'password' ? 'text' : 'password';
  btn.textContent = el.type === 'password' ? '👁' : '🙈';
}

async function saveWifi() {
  if (!isPremium()) return toast('هذه الميزة للمشتركين المدفوعين', 'bad');
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
  if (!isPremium()) return toast('هذه الميزة للمشتركين المدفوعين', 'bad');
  const pass = randomPassword(14);
  const ssid = 'WiFi-' + randomPassword(4).toUpperCase();
  if (!confirm('سيُقطع اتصال جميع الأجهزة momentarily. متابعة؟')) return;
  try {
    await ROUTER.wifiSet({ ssid, password: pass, band: 'both' });
    $('#wSsid').value = ssid; $('#wPass').value = pass; pwMeter();
    pushLog('wifi', 'تدوير الشبكة');
    toast('تم تدوير الشبكة', 'ok');
  } catch (e) { toast(e.message, 'bad'); }
}

/* ---------- تغيير كلمة مرور الراوتر (زر واحد — بلا أي إعداد خارجي) ---------- */
async function saveRouterPass() {
  if (!isPremium()) return toast('هذه الميزة للمشتركين المدفوعين', 'bad');
  const np = $('#rNewPass').value.trim();
  if (!np || np.length < 5) return toast('كلمة المرور قصيرة (5 أحرف على الأقل)', 'bad');
  if (!confirm('سيتم تغيير كلمة مرور حساب الراوتر فوراً. هل أنت متأكد؟')) return;
  try {
    const r = await ROUTER.setAdminPassword(np, (ME.router && ME.router.username) || 'root');
    if (ME.router) ME.router.password = np;
    await api.post('/api/me/router-password', { password: np });
    pushLog('router', 'تغيير كلمة مرور الراوتر');
    toast(r.verified ? 'تم تغيير كلمة المرور وتأكيدها ✅' : 'تم التغيير', 'ok');
    $('#rNewPass').value = '';
  } catch (e) { toast('تعذّر التغيير: ' + e.message, 'bad'); }
}

/* ============================ الاشتراك ============================ */
function renderSub() {
  const box = $('#mySub');
  if (ME.role === 'admin') {
    box.innerHTML = `<div class="kv"><span>أنت مدير النظام</span><b>كل الصلاحيات مفعّلة</b></div>`;
  } else if (ME.active && ME.subEnd) {
    const plan = PLANS().find(p => p.id === ME.plan);
    box.innerHTML = `
      <div class="kv"><span>الحالة</span><b><span class="pill p-ok">بريميوم ⭐</span></b></div>
      <div class="kv"><span>الباقة</span><b>${esc(plan ? plan.label : ME.plan)}</b></div>
      <div class="kv"><span>ينتهي في</span><b>${fmtDate(ME.subEnd)}</b></div>
      <div class="kv"><span>المتبقي</span><b><span class="pill p-warn">⏳ ${myDaysLeft()} يوم</span></b></div>
      <div class="kv"><span>عدد الأجهزة المسموح</span><b>${ME.maxDev || 3}</b></div>
      <div class="kv"><span>المميزات</span><b>مفتوحة بالكامل ✅</b></div>`;
  } else {
    const pend = store.get('pendingSub', null);
    box.innerHTML = pend
      ? `<div class="kv"><span>الحالة</span><b><span class="pill p-warn">قيد المراجعة عند المشرف</span></b></div>
         <div class="dim small" style="line-height:1.9;margin-top:8px">طلبك مسجَّل. فور اعتماده من لوحة الإدارة تُفتح كل المميزات تلقائياً في هذه الشاشة.</div>`
      : `<div class="dim small" style="line-height:1.9">لا يوجد اشتراك مفعّل بعد — المميزات مقفلة. اطلب الباقة أو أدخل الكود الذي وصلك.</div>`;
  }
  $('#plansBox').innerHTML = PLANS().map(p => `
    <div class="pc">
      <b>${esc(p.label)}</b>
      <div class="price">${esc(p.price)} <small>${esc((CFG.app && CFG.app.currency) || '')}</small></div>
      <div class="dim small">${p.days} يوم · حتى ${p.maxDev} أجهزة</div>
      <button class="btn wa blk" style="margin-top:10px" onclick="waRequest('${p.id}')">📲 اطلب هذه الباقة</button>
    </div>`).join('');
}

function openRedeem() {
  openModal(`
    <h3 style="margin-bottom:10px">🎟️ تفعيل كود</h3>
    <div class="dim small" style="margin-bottom:10px">أدخل الكود الذي وصلك من الإدارة — يُستخدم مرة واحدة فقط ويحوّلك إلى بريميوم فوراً.</div>
    <input id="rdCode" placeholder="WH-XXXXX-XXXXX-XXXXX-XXXXX" style="direction:ltr;text-align:center">
    <div class="err" id="rdErr"></div>
    <button id="btnRedeem" class="btn p blk" style="margin-top:12px" onclick="doRedeem()">تفعيل</button>`);
}

async function doRedeem() {
  hideErr('#rdErr');
  const code = $('#rdCode').value.trim().toUpperCase();
  if (!code) return showErr('#rdErr', 'أدخل الكود');
  const btn = $('#btnRedeem'); if (btn) { btn.disabled = true; btn.textContent = '…جارٍ التفعيل'; }
  try {
    const r = await api.post('/api/redeem', { code });
    ME = r.user; ME.active = ME.premium; ME.sub = r.user.subEnd ? { plan: r.user.plan, end: r.user.subEnd, maxDev: r.user.maxDev } : null;
    store.del('pendingSub');
    if (ME.router) { ROUTER = new Router(ME.router); connectRouter(); }
    closeModal();
    toast(r.message || 'تم التفعيل ✅', 'ok');
    renderAll();
  } catch (e) {
    showErr('#rdErr', e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'تفعيل'; }
  }
}

/* ---------- طلب الباقة عبر واتساب (رسالة مميزة) ---------- */
function waRequest(planId) {
  const wa = String((CFG.app && CFG.app.whatsapp) || '963957869853').replace(/\D/g, '');
  const plan = PLANS().find(p => p.id === planId);
  const label = plan ? `${plan.label} — ${plan.days} يوم بسعر ${plan.price} ${(CFG.app && CFG.app.currency) || ''}` : 'اختيار من التطبيق';
  const date = new Date().toLocaleDateString('ar');
  const appName = (CFG.app && CFG.app.name) || 'WiFi Hub';
  const msg =
    `⭐ *طلب اشتراك ${appName}* ⭐\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📦 *الباقة المطلوبة:* ${label}\n` +
    `👤 *اسم المستخدم:* ${ME ? ME.username : '—'}\n` +
    `📅 *التاريخ:* ${date}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔑 أرسل لي كود التفعيل وسأدخله في البرنامج،\n` +
    `عندها تتحوّل حالتي إلى *بريميوم* وتُفتح كل المميزات فوراً.`;
  const link = `https://wa.me/${wa}?text=${encodeURIComponent(msg)}`;
  /* في التطبيق الأصلي نفتح المتصفح الخارجي، وفي المتصفح نافذة جديدة */
  if (globalThis.WiFiHub && typeof globalThis.WiFiHub.openExternal === 'function') {
    try { globalThis.WiFiHub.openExternal(link); } catch (e) { window.open(link, '_blank'); }
  } else {
    window.open(link, '_blank');
  }
  /* تسجيل الطلب في قاعدة البيانات ليظهر للمدير فوراً */
  try {
    const plan = planId || (ME && ME.plan) || '';
    api.post('/api/request', { plan }).then(() => {
      store.set('pendingSub', { plan, at: now() });
      renderSub();
    }).catch(() => {});
  } catch (e) {}
}

/* ============================ لوحة الإدارة ============================ */
let ADMIN_DATA = null;

async function renderAdmin() {
  if (!ME || ME.role !== 'admin') return;
  let d;
  try { d = await api.get('/api/admin/overview'); }
  catch (e) { toast(e.message, 'bad'); return; }
  ADMIN_DATA = d;
  const s = d.stats;

  /* شريط الإحصاءات */
  $('#admStats').innerHTML = [
    ['المشتركون', s.users, '👥'], ['بريميوم', s.premium, '⭐'], ['مجاني', s.free, '🆓'],
    ['طلبات معلّقة', s.pendingRequests, '📨'], ['أكواد متاحة', s.codesAvailable, '🔑'],
    ['أكواد مستخدمة', s.codesUsed, '✅'], ['متصلون الآن', s.online, '📡']
  ].map(x => `<div class="card stat"><span>${x[2]} ${x[0]}</span><b>${x[1]}</b></div>`).join('');

  /* الطلبات المعلّقة */
  $('#tblFree').innerHTML = `<thead><tr><th>الاسم</th><th>الباقة</th><th>الوقت</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>` +
    (d.requests.length ? d.requests.map(r => `<tr><td><b>${esc(r.username)}</b></td>
      <td>${esc((PLANS().find(p => p.id === r.plan) || {}).label || r.plan || '—')}</td>
      <td>${r.at ? relTime(r.at) : '—'}</td>
      <td><span class="pill ${r.status === 'approved' ? 'p-ok' : r.status === 'rejected' ? 'p-bad' : 'p-warn'}">${r.status === 'approved' ? 'مقبول' : r.status === 'rejected' ? 'مرفوض' : 'معلّق'}</span></td>
      <td style="white-space:normal">${r.status === 'pending' ? `
        <button class="btn sm p" onclick="approveReq(${r.id})">✅ تفعيل</button>
        <button class="btn sm d" onclick="rejectReq(${r.id})">✕ رفض</button>` : '—'}</td></tr>`).join('')
      : `<tr><td colspan="5" class="center dim" style="padding:22px">لا توجد طلبات</td></tr>`) + '</tbody>';

  /* المشتركون */
  const q = ($('#fUser').value || '').toLowerCase();
  const subs = d.subscribers.filter(s2 => !q || String(s2.username).toLowerCase().includes(q));
  $('#tblSubs').innerHTML = `<thead><tr><th>الاسم</th><th>الحالة</th><th>الباقة</th><th>ينتهي</th><th>المتبقي</th><th>الأجهزة</th><th>الكود</th><th>إجراءات</th></tr></thead><tbody>` +
    (subs.length ? subs.map(s2 => {
      const prem = s2.status === 'premium';
      const pl = PLANS().find(p => p.id === s2.plan);
      const devCount = Array.isArray(s2.devices) ? s2.devices.length : 0;
      return `<tr><td><b>${esc(s2.username)}</b>${s2.role === 'admin' ? ' <span class="pill p-warn">👑 مدير</span>' : ''}
        <div class="dim small">آخر ظهور: ${s2.lastSeen ? relTime(s2.lastSeen) : '—'}</div></td>
      <td>${s2.role === 'admin' ? '<span class="pill p-warn">مدير</span>' : prem ? '<span class="pill p-ok">بريميوم</span>' : '<span class="pill p-muted">مجاني</span>'}</td>
      <td>${esc(pl ? pl.label : s2.plan || '—')}</td>
      <td>${s2.subEnd ? fmtDate(s2.subEnd) : '—'}</td>
      <td>${prem ? '<span class="pill p-warn">' + s2.daysLeft + ' يوم</span>' : '—'}</td>
      <td>${devCount}/${s2.maxDev || (pl ? pl.maxDev : 3)}</td>
      <td class="mono">${esc(s2.code || '—')}</td>
      <td style="white-space:normal">
        <button class="btn sm" onclick="extendSub('${esc(s2.username)}',30)">+30 يوم</button>
        <button class="btn sm w" onclick="extendSub('${esc(s2.username)}',90)">+90 يوم</button>
        ${prem ? '' : `<button class="btn sm p" onclick="promoteFree('${esc(s2.username)}')">✅ تفعيل</button>`}
        <button class="btn sm d" onclick="delSub('${esc(s2.username)}')">حذف</button></td></tr>`;
    }).join('')
      : `<tr><td colspan="8" class="center dim" style="padding:22px">لا يوجد مشتركون بعد</td></tr>`) + '</tbody>';

  /* الأكواد */
  const planSel = $('#codePlan');
  const cur = planSel.value;
  planSel.innerHTML = PLANS().map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  if (cur) planSel.value = cur;
  $('#tblCodes').innerHTML = `<thead><tr><th>الكود</th><th>الباقة</th><th>الأجهزة</th><th>الحالة</th><th>ملاحظة</th><th></th></tr></thead><tbody>` +
    (d.codes.length ? d.codes.map(c => `<tr><td class="mono">${esc(c.code)}</td>
      <td>${esc((PLANS().find(p => p.id === c.plan) || {}).label || c.plan)}</td>
      <td>${c.maxDev}</td>
      <td>${c.usedBy ? '<span class="pill p-info">مستخدم: ' + esc(c.usedBy) + '</span>' : '<span class="pill p-ok">متاح</span>'}</td>
      <td class="small dim">${esc(c.note || '')}${c.expiresAt ? ' · ينتهي ' + fmtDate(c.expiresAt) : ''}</td>
      <td><button class="btn sm d" onclick="delCode('${esc(c.code)}')">حذف</button></td></tr>`).join('')
      : `<tr><td colspan="6" class="center dim" style="padding:22px">لا توجد أكواد — ولّد أكواداً من الأعلى</td></tr>`) + '</tbody>';

  /* الإعدادات */
  $('#admUser').value = d.settings.adminUsername || 'boss';
  $('#rBase').value = (d.settings.router && d.settings.router.base) || '';
  $('#rUser').value = (d.settings.router && d.settings.router.username) || 'root';
  $('#rPass').value = (d.settings.router && d.settings.router.password) || '';
  $('#rWa').value = (d.settings.app && d.settings.app.whatsapp) || '';
  $('#rAuto').value = d.settings.autoApprove ? '1' : '0';
}

/* ---------- إجراءات الإدارة ---------- */
async function approveReq(id) {
  try {
    await api.post('/api/admin/requests/' + id + '/approve', {});
    toast('تم تفعيل الاشتراك — تصل الرسالة للمشترك فوراً', 'ok');
    await renderAdmin();
  } catch (e) { toast(e.message, 'bad'); }
}
async function rejectReq(id) {
  try { await api.post('/api/admin/requests/' + id + '/reject', {}); toast('تم رفض الطلب', 'ok'); await renderAdmin(); }
  catch (e) { toast(e.message, 'bad'); }
}
async function extendSub(username, days) {
  try { await api.post('/api/admin/subscribers/' + encodeURIComponent(username) + '/extend', { days }); toast('تم تمديد ' + username, 'ok'); await renderAdmin(); }
  catch (e) { toast(e.message, 'bad'); }
}
async function promoteFree(username) {
  const plan = PLANS()[0];
  const pick = prompt('أيام الباقة للمستخدم ' + username + ':', String(plan ? plan.days : 30));
  if (pick === null) return;
  try {
    await api.post('/api/admin/subscribers/' + encodeURIComponent(username) + '/promote', { plan: plan ? plan.id : '', days: +pick || 30 });
    toast('تم تفعيل اشتراك ' + username, 'ok');
    await renderAdmin();
  } catch (e) { toast(e.message, 'bad'); }
}
async function delSub(username) {
  if (!confirm('حذف المشترك ' + username + '؟')) return;
  try { await api.del('/api/admin/subscribers/' + encodeURIComponent(username)); toast('تم الحذف', 'ok'); await renderAdmin(); }
  catch (e) { toast(e.message, 'bad'); }
}
async function delCode(code) {
  if (!confirm('حذف الكود ' + code + '؟')) return;
  try { await api.del('/api/admin/codes/' + encodeURIComponent(code)); toast('تم حذف الكود', 'ok'); await renderAdmin(); }
  catch (e) { toast(e.message, 'bad'); }
}

async function genCodes() {
  const plan = $('#codePlan').value, maxDev = +$('#codeMaxDev').value || 3;
  const qty = +$('#codeQty').value || 1;
  const exp = $('#codeExp').value;
  const expiresAt = exp ? new Date(exp + 'T23:59:59').getTime() : 0;
  const note = ($('#codeNote') && $('#codeNote').value || '').slice(0, 120);
  try {
    const r = await api.post('/api/admin/codes', { plan, maxDev, qty, expiresAt, note });
    $('#newCodes').innerHTML = `<div class="code">${r.codes.join('<br>')}</div>`;
    $('#newCodes').dataset.codes = r.codes.join(',');
    $('#btnCopyAll').classList.remove('hide');
    $('#btnDlCodes').classList.remove('hide');
    toast(`تم توليد ${r.codes.length} كود (لمرة واحدة) وحفظها في قاعدة البيانات`, 'ok');
    await renderAdmin();
  } catch (e) { toast(e.message, 'bad'); }
}
function copyAllCodes() {
  const t = $('#newCodes').dataset.codes || '';
  navigator.clipboard.writeText(t.replace(/,/g, '\n')).then(() => toast('تم النسخ', 'ok'));
}
function downloadCodes() {
  const link = (globalThis.WIFIHUB_BUILD && globalThis.WIFIHUB_BUILD.apiUrl || '') + '/api/admin/export/codes.csv';
  window.open(link + '?token=' + encodeURIComponent(localStorage.getItem('wifihub.token') || sessionStorage.getItem('wifihub.token') || ''), '_blank');
}

async function saveAdminCreds() {
  const user = $('#admUser').value.trim();
  const np = $('#admPass').value;
  if (!user || user.length < 3) return toast('اسم مستخدم الإدارة قصير (3 أحرف)', 'bad');
  if (np && np.length < 4) return toast('كلمة مرور الإدارة قصيرة (4 أحرف)', 'bad');
  try {
    await api.post('/api/admin/settings', { adminUsername: user, adminPassword: np || undefined });
    toast('تم حفظ بيانات الإدارة (مُشفَّرة في قاعدة البيانات)', 'ok');
    $('#admPass').value = '';
    await renderAdmin();
  } catch (e) { toast(e.message, 'bad'); }
}

async function saveRouterCfg() {
  try {
    await api.post('/api/admin/settings', {
      app: { whatsapp: $('#rWa').value.trim() },
      router: { base: $('#rBase').value.trim(), username: $('#rUser').value.trim() || 'root', password: $('#rPass').value },
      autoApprove: $('#rAuto').value === '1'
    });
    toast('تم حفظ الإعدادات', 'ok');
    await renderAdmin();
  } catch (e) { toast(e.message, 'bad'); }
}

async function rebootRouter() {
  if (!confirm('إعادة تشغيل الراوتر؟')) return;
  try {
    if (!ROUTER) { toast('لا يوجد اتصال بالراوتر', 'bad'); return; }
    await ROUTER.reboot(); toast('تم إرسال أمر إعادة التشغيل', 'ok');
  } catch (e) { toast(e.message, 'bad'); }
}

async function syncNow() {
  try { await renderAdmin(); toast('تمت المزامنة', 'ok'); }
  catch (e) { toast(e.message, 'bad'); }
}

/* ============================ متنوّع ============================ */
function pushLog(type, txt) {
  LOG.unshift({ t: now(), type, txt });
  LOG = LOG.slice(0, 60);
  store.set('log', LOG);
}
function showErr(sel, msg) { const e = $(sel); if (!e) return; e.textContent = msg; e.style.display = 'block'; }
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

/* ============================ واجهة عامة ============================ */
Object.assign(globalThis, {
  showSection, authTab, doLogin, doRegister, doAdminLogin, doLogout, refreshAll, renderDevices,
  doFreeze, doBlock, doKick, doRename, saveWifi, rollWifi, randPass, togglePw, pwMeter,
  openRedeem, doRedeem, waRequest, genCodes, copyAllCodes, downloadCodes, delCode,
  approveReq, rejectReq, extendSub, delSub, promoteFree, saveAdminCreds, saveRouterCfg,
  rebootRouter, syncNow, saveRouterPass, openModal, closeModal, toggleTheme, renderAdmin, renderSubs: renderAdmin
});

boot();
