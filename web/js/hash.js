/* WiFi Hub — تشفير بيانات الدخول (SHA-256 مع salt)
 * كلمة مرور الإدارة تُخزَّن مشفَّرة داخل hub.json ولا تُخزَّن أبداً كنص صريح.
 */

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomSalt(len = 16) {
  const b = new Uint8Array(len);
  (globalThis.crypto || globalThis.msCrypto).getRandomValues(b);
  return toHex(b);
}

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  if (globalThis.crypto && globalThis.crypto.subtle) {
    const d = await globalThis.crypto.subtle.digest('SHA-256', data);
    return toHex(d);
  }
  /* احتياطي بسيط لو لم يتوفر SubtleCrypto (سياق غير آمن) */
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < data.length; i++) {
    h1 = Math.imul(h1 ^ data[i], 16777619) >>> 0;
    h2 = Math.imul(h2 + data[i] + i, 2246822519) >>> 0;
  }
  return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
}

export async function makeHash(password, salt = randomSalt()) {
  const hash = await sha256Hex(salt + ':' + String(password));
  return { salt, hash };
}

export async function verifyPassword(password, salt, hash) {
  if (!hash) return false;
  const h = await sha256Hex((salt || '') + ':' + String(password));
  return h.toLowerCase() === String(hash).toLowerCase();
}

/* مقارنة آمنة زمنياً (تقريباً) */
export function safeEqual(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
