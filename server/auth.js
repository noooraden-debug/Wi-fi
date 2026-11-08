/* WiFi Hub — المصادقة: تجزئة كلمات المرور، الجلسات، توليد الأكواد */

import crypto from 'node:crypto';
import {
  db, findUser, createUser, updateUser, findSession, createSession, deleteSession,
  getSetting, setSetting, getPlans
} from './db.js';

const DAY = 86400000;

/* ---------- تجزئة كلمة المرور (scrypt) ---------- */
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
export function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  try {
    const calc = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(calc, 'hex'), b = Buffer.from(String(hash), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

/* ---------- جلسات ---------- */
export function issueSession(user, remember = false) {
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = remember ? 30 * DAY : 12 * 3600e3;   /* تذكّرني = 30 يوماً، وإلا 12 ساعة */
  createSession({ token, username: user.username, role: user.role, remember: remember ? 1 : 0, ttl });
  return { token, expires: Date.now() + ttl, remember: !!remember };
}

export function sessionUser(token) {
  if (!token) return null;
  const s = findSession(token);
  if (!s) return null;
  if (s.expires && s.expires < Date.now()) { deleteSession(token); return null; }
  const u = findUser(s.username);
  if (!u) { deleteSession(token); return null; }
  updateUser(u.id, { last_seen: Date.now() });
  return u;
}

export function revokeSession(token) { if (token) deleteSession(token); }

/* ---------- بيانات دخول الإدارة ---------- */
export const DEFAULT_ADMIN = { username: 'boss', password: '9876' };

export function ensureAdmin() {
  const uname = getSetting('admin_username', DEFAULT_ADMIN.username);
  const stored = getSetting('admin_hash', null);
  const storedSalt = getSetting('admin_salt', null);
  if (stored && storedSalt) return { username: uname, password: null };
  /* أول تشغيل: ننشئ حساب المدير بالبيانات الافتراضية */
  const { salt, hash } = hashPassword(DEFAULT_ADMIN.password);
  setSetting('admin_username', DEFAULT_ADMIN.username);
  setSetting('admin_salt', salt);
  setSetting('admin_hash', hash);
  const existing = findUser(DEFAULT_ADMIN.username);
  if (existing) {
    updateUser(existing.id, { role: 'admin', salt, pass: hash });
  } else {
    createUser({ username: DEFAULT_ADMIN.username, pass: hash, salt, role: 'admin', max_dev: 999 });
  }
  return { username: DEFAULT_ADMIN.username, password: DEFAULT_ADMIN.password };
}

export function adminCredentials() {
  return { username: getSetting('admin_username', DEFAULT_ADMIN.username) };
}

export function changeAdminCredentials(username, password) {
  const old = findUser(getSetting('admin_username', DEFAULT_ADMIN.username));
  let salt = getSetting('admin_salt', null);
  let hash = getSetting('admin_hash', null);
  /* كلمة المرور اختيارية: إن لم تُمرَّر نحتفظ بالهاش الحالي ونغيّر الاسم فقط */
  if (password) {
    const h = hashPassword(password);
    salt = h.salt; hash = h.hash;
    setSetting('admin_salt', salt);
    setSetting('admin_hash', hash);
  }
  setSetting('admin_username', username);
  if (old) updateUser(old.id, { username, salt, pass: hash, role: 'admin' });
  else createUser({ username, pass: hash, salt, role: 'admin', max_dev: 999 });
  return { username };
}

export function checkAdmin(username, password) {
  const admin = findUser(getSetting('admin_username', DEFAULT_ADMIN.username));
  if (!admin || admin.role !== 'admin') return false;
  if (String(username).trim().toLowerCase() !== String(admin.username).toLowerCase()) return false;
  return verifyPassword(password, admin.salt, admin.pass);
}

/* ---------- توليد الأكواد ---------- */
/* أبجدية بلا أحرف متشابهة (0/O، 1/I/L) — 31 محرفاً */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomChars(len) {
  const out = [];
  const max = 256 - (256 % ALPHABET.length);   /* رفض التحيّز */
  while (out.length < len) {
    const buf = crypto.randomBytes(len * 2);
    for (const b of buf) {
      if (b >= max) continue;
      out.push(ALPHABET[b % ALPHABET.length]);
      if (out.length === len) break;
    }
  }
  return out.join('');
}

/* كود: WH-XXXXX-XXXXX-XXXXX-XXXXX  (20 خانة عشوائية ≈ 100 بت) */
export function generateCode() {
  const raw = randomChars(20);
  return 'WH-' + raw.slice(0, 5) + '-' + raw.slice(5, 10) + '-' + raw.slice(10, 15) + '-' + raw.slice(15, 20);
}

export function planById(id) {
  return getPlans().find(p => p.id === id) || null;
}
