/* WiFi Hub — أدوات مساعدة عامة */

export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

export function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function fmtBytes(b) {
  b = Number(b) || 0;
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1, n = b;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}

export function fmtDate(t) {
  if (!t) return '—';
  const d = new Date(Number(t));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ar', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(t) {
  if (!t) return '—';
  const d = new Date(Number(t));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('ar', { hour: '2-digit', minute: '2-digit' });
}

export function daysLeft(t) {
  if (!t) return 0;
  return Math.max(0, Math.ceil((Number(t) - Date.now()) / 86400000));
}

export function relTime(t) {
  const s = Math.floor((Date.now() - Number(t || 0)) / 1000);
  if (s < 60) return 'الآن';
  if (s < 3600) return Math.floor(s / 60) + ' دقيقة';
  if (s < 86400) return Math.floor(s / 3600) + ' ساعة';
  return Math.floor(s / 86400) + ' يوم';
}

/* تخزين محلي آمن */
const NS = 'wifihub.';
export const store = {
  get(k, d = null) {
    try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); }
    catch (e) { return d; }
  },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(NS + k); } catch (e) {} }
};

/* واجهة مع التطبيق الأصلي (Android) أو المتصفح */
export function toast(msg, kind = '') {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.style.cssText = 'position:fixed;bottom:18px;inset-inline-start:18px;z-index:999;display:flex;flex-direction:column;gap:8px;max-width:92vw';
    document.body.appendChild(box);
  }
  const d = document.createElement('div');
  d.className = 'toast ' + kind;
  d.textContent = msg;
  d.style.cssText = 'background:var(--panel);border:1px solid var(--line2);border-radius:12px;padding:11px 15px;' +
    'box-shadow:var(--shadow);font-size:14px;max-width:90vw';
  if (kind === 'ok') d.style.borderColor = 'rgba(37,208,160,.55)';
  if (kind === 'bad') d.style.borderColor = 'rgba(255,92,114,.55)';
  box.appendChild(d);
  setTimeout(() => { d.style.opacity = '0'; d.style.transition = '.4s'; setTimeout(() => d.remove(), 400); }, 3600);
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const now = () => Date.now();

/* توليد كود عشوائي قوي (cryptographically secure)
 * أبجدية بلا أحرف متشابهة (0/O، 1/I/L)، بطول 25 خانة ≈ 125 بت عشوائية */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomChars(len) {
  const A = CODE_ALPHABET;
  const b = new Uint8Array(len);
  const c = globalThis.crypto || globalThis.msCrypto;
  if (!c || !c.getRandomValues) throw new Error('مولّد العشوائية غير متوفر');
  c.getRandomValues(b);
  return Array.from(b).map(x => A[x % A.length]).join('');
}

/* كود اشتراك: WH-XXXXX-XXXXX-XXXXX-XXXXX */
export function randomCode() {
  const raw = randomChars(20);
  return 'WH-' + raw.slice(0, 5) + '-' + raw.slice(5, 10) + '-' + raw.slice(10, 15) + '-' + raw.slice(15, 20);
}

/* كود عشوائي لكلمة مرور (عادي) */
export function randomPassword(len = 14) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = new Uint8Array(len);
  (globalThis.crypto || globalThis.msCrypto).getRandomValues(b);
  return Array.from(b).map(x => A[x % A.length]).join('');
}
