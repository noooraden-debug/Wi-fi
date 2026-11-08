/* WiFi Hub — عميل الخادم الداخلي (REST + قناة لحظية)
 * كل البيانات (الحسابات · الأكواد · الاشتراكات · الإعدادات) في قاعدة SQLite
 * الداخلية، والربط بين لوحة الإدارة والمشتركين لحظي عبر SSE.
 */

import { Bridge } from './ubus.js';

/* عنوان الخادم: نفس الأصل افتراضياً، ويمكن حقنه عند البناء (للتطبيق الأصلي) */
const BUILD = (globalThis.WIFIHUB_BUILD || {});
export const API_BASE = (BUILD.apiUrl || '').replace(/\/+$/, '');

const LS = 'wifihub.';
const mem = {
  get(k) { try { return sessionStorage.getItem(LS + k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(LS + k, v); } catch (e) {} },
  del(k) { try { sessionStorage.removeItem(LS + k); } catch (e) {} }
};
const disk = {
  get(k) { try { return localStorage.getItem(LS + k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(LS + k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(LS + k); } catch (e) {} }
};

export function url(p) { return API_BASE + p; }

export function getToken() { return mem.get('token') || disk.get('token') || ''; }
export function setToken(token, remember) {
  mem.del('token'); disk.del('token');
  if (!token) return;
  if (remember) disk.set('token', token); else mem.set('token', token);
}
export function getSavedUser() {
  try { return JSON.parse(disk.get('user') || mem.get('user') || 'null'); } catch (e) { return null; }
}
export function setSavedUser(u, remember) {
  mem.del('user'); disk.del('user');
  if (!u) return;
  const s = JSON.stringify(u);
  if (remember) disk.set('user', s); else mem.set('user', s);
}

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) headers['Authorization'] = 'Bearer ' + t;
  /* في التطبيق الأصلي نستخدم الجسر المحلي (بلا قيود CORS) */
  if (Bridge.native) {
    const raw = await Bridge.http(url(path), method, body === undefined ? null : JSON.stringify(body), headers);
    if (raw.error) throw new Error('تعذّر الاتصال بالخادم — تأكّد من تشغيله');
    let j = null;
    try { j = raw.body ? JSON.parse(raw.body) : null; } catch (e) { j = null; }
    if (raw.status < 200 || raw.status >= 300) {
      const err = new Error((j && j.error) || ('خطأ من الخادم (' + raw.status + ')'));
      err.status = raw.status;
      throw err;
    }
    return j;
  }
  const opt = { method, headers, cache: 'no-store' };
  if (body !== undefined) opt.body = JSON.stringify(body);
  let res;
  try { res = await fetch(url(path), opt); }
  catch (e) { throw new Error('تعذّر الاتصال بالخادم — تأكّد من تشغيله'); }
  let j = null;
  const text = await res.text();
  if (text) { try { j = JSON.parse(text); } catch (e) { j = null; } }
  if (!res.ok) {
    const err = new Error((j && j.error) || ('خطأ من الخادم (' + res.status + ')'));
    err.status = res.status;
    throw err;
  }
  return j;
}

export const api = {
  get: p => request('GET', p),
  post: (p, b) => request('POST', p, b || {}),
  del: p => request('DELETE', p)
};

/* ---------- القناة اللحظية ---------- */
let es = null;
export function openStream(onEvent) {
  closeStream();
  const t = getToken();
  if (!t) return null;
  try {
    es = new EventSource(url('/api/stream') + '?token=' + encodeURIComponent(t));
    es.onmessage = e => {
      let d = null;
      try { d = JSON.parse(e.data); } catch (_) {}
      if (d) onEvent(d);
    };
    es.onerror = () => { /* المتصفح يعيد الاتصال تلقائياً */ };
  } catch (e) {}
  return es;
}
export function closeStream() {
  if (es) { try { es.close(); } catch (e) {} es = null; }
}
