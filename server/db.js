/* WiFi Hub — قاعدة البيانات الداخلية (SQLite)
 * قاعدة واحدة تجمع: الحسابات · الاشتراكات · الأكواد · الطلبات · الجلسات · الإعدادات
 * تُنشأ تلقائياً عند أول تشغيل، ولا تحتاج أي تثبيت خارجي (node:sqlite مدمج).
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.WIFIHUB_DATA || path.join(process.cwd(), 'data');
const DB_FILE = process.env.WIFIHUB_DB || path.join(DATA_DIR, 'wifihub.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pass     TEXT NOT NULL,
  salt     TEXT NOT NULL,
  role     TEXT NOT NULL DEFAULT 'user',
  plan     TEXT,
  sub_start INTEGER,
  sub_end  INTEGER,
  max_dev  INTEGER DEFAULT 3,
  phone    TEXT,
  devices  TEXT DEFAULT '[]',
  status   TEXT DEFAULT 'free',
  created  INTEGER,
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  plan       TEXT NOT NULL,
  max_dev    INTEGER DEFAULT 3,
  expires_at INTEGER DEFAULT 0,
  used_by    TEXT,
  used_at    INTEGER DEFAULT 0,
  note       TEXT DEFAULT '',
  created    INTEGER
);

CREATE TABLE IF NOT EXISTS requests (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  plan     TEXT,
  phone    TEXT DEFAULT '',
  note     TEXT DEFAULT '',
  at       INTEGER,
  status   TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS sessions (
  token    TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  role     TEXT NOT NULL,
  remember INTEGER DEFAULT 0,
  created  INTEGER,
  expires  INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  type     TEXT,
  username TEXT,
  data     TEXT,
  at       INTEGER
);

CREATE INDEX IF NOT EXISTS ix_users_name  ON users(username);
CREATE INDEX IF NOT EXISTS ix_codes_used  ON codes(used_by);
CREATE INDEX IF NOT EXISTS ix_req_status  ON requests(status);
`);

/* ===================== الإعدادات العامة (key/value) ===================== */
export function getSetting(key, fallback = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}
export function getJSON(key, fallback) {
  const v = getSetting(key, null);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}
export function setJSON(key, obj) { setSetting(key, JSON.stringify(obj)); }

/* ===================== المستخدمون ===================== */
export const findUser = name =>
  db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(String(name || '')) || null;

export const userById = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;

export const listUsers = () => db.prepare('SELECT * FROM users ORDER BY id ASC').all();

export function createUser({ username, pass, salt, role = 'user', max_dev = 3, phone = '' }) {
  const info = db.prepare(
    `INSERT INTO users(username, pass, salt, role, max_dev, phone, status, created, last_seen)
     VALUES(?,?,?,?,?,?, 'free', ?, ?)`
  ).run(username, pass, salt, role, max_dev, phone, Date.now(), Date.now());
  return userById(info.lastInsertRowid);
}

export function updateUser(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
}

/* ===================== الأكواد ===================== */
export const findCode = code =>
  db.prepare('SELECT * FROM codes WHERE code = ?').get(String(code || '').trim().toUpperCase()) || null;

export const listCodes = () => db.prepare('SELECT * FROM codes ORDER BY id DESC').all();

export function insertCode({ code, plan, max_dev = 3, expires_at = 0, note = '' }) {
  db.prepare('INSERT INTO codes(code, plan, max_dev, expires_at, note, created) VALUES(?,?,?,?,?,?)')
    .run(code, plan, max_dev, expires_at || 0, note || '', Date.now());
}

/* ===================== الطلبات ===================== */
export const listRequests = () => db.prepare('SELECT * FROM requests ORDER BY id DESC').all();
export const findRequest = id => db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(id)) || null;

export function createRequest({ username, plan, phone = '', note = '' }) {
  const info = db.prepare('INSERT INTO requests(username, plan, phone, note, at, status) VALUES(?,?,?,?,?,?)')
    .run(username, plan, phone, note, Date.now(), 'pending');
  return findRequest(info.lastInsertRowid);
}

export function updateRequest(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE requests SET ${sets} WHERE id = ?`).run(...keys.map(k => fields[k]), Number(id));
}

/* ===================== الجلسات ===================== */
export const findSession = token =>
  db.prepare('SELECT * FROM sessions WHERE token = ?').get(String(token || '')) || null;

export function createSession({ token, username, role, remember = 0, ttl }) {
  db.prepare('INSERT INTO sessions(token, username, role, remember, created, expires) VALUES(?,?,?,?,?,?)')
    .run(token, username, role, remember ? 1 : 0, Date.now(), Date.now() + Number(ttl || 0));
}
export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token || ''));
}

/* ===================== الأحداث ===================== */
export function logEvent(type, username = '', data = {}) {
  db.prepare('INSERT INTO events(type, username, data, at) VALUES(?,?,?,?)')
    .run(type, username || '', JSON.stringify(data || {}), Date.now());
}
export const recentEvents = (limit = 50) =>
  db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(Number(limit) || 50);

/* ===================== الباقات ===================== */
export const DEFAULT_PLANS = [
  { id: 'm1',  label: 'شهري',    days: 30,  price: 100, maxDev: 3 },
  { id: 'm3',  label: '3 أشهر',  days: 90,  price: 250, maxDev: 5 },
  { id: 'm6',  label: '6 أشهر',  days: 180, price: 450, maxDev: 10 },
  { id: 'm12', label: 'سنة',     days: 365, price: 700, maxDev: 15 }
];

export function getPlans() {
  const p = getJSON('plans', null);
  return Array.isArray(p) && p.length ? p : DEFAULT_PLANS;
}

export function getRouterCfg() {
  return Object.assign(
    { base: '', username: 'root', password: '', wifiIfaces: [] },
    getJSON('router', {})
  );
}

export function getAppCfg() {
  return Object.assign(
    { name: 'WiFi Hub', owner: 'المالك', whatsapp: '963957869853', currency: 'ريال' },
    getJSON('app', {})
  );
}

export const isPremiumUser = u =>
  !!(u && (u.role === 'admin' || (u.sub_end && u.sub_end > Date.now())));

export const daysLeftOf = u => (u && u.sub_end ? Math.max(0, Math.ceil((u.sub_end - Date.now()) / 864e5)) : 0);

export { DB_FILE, DATA_DIR };
