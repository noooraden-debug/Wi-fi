/* WiFi Hub — مدير ملف الإعدادات (المصدر الوحيد: GitHub)
 *
 * الملف: hub.json  (يُرفع على GitHub)
 * التطبيق يقرأه مباشرة من raw.githubusercontent.com (أو رابط خاص + توكن قراءة)
 * ولا يحتاج أي سيرفر يعمل.
 */

import { store } from './util.js';

export const DEFAULTS = {
  app: {
    name: 'WiFi Hub', owner: 'المالك', whatsapp: '963957869853', currency: 'ريال',
    /* دخول الإدارة: كلمة المرور مخزَّنة مُشفَّرة (SHA-256 + salt) لا كنص صريح */
    admin: { username: 'admin', salt: '', hash: '' }
  },
  settings: {
    autoApprove: false,        // تفعيل الاشتراك تلقائياً من طلبات الواتساب
    allowSelfService: true,    // السماح للمشترك بطلب الاشتراك بنفسه
    pollSeconds: 60,           // كم مرة يحدّث التطبيق بياناته من GitHub
    features: { wifi: true, block: true, freeze: true, limit: true, rename: true, reboot: false }
  },
  plans: [
    { id: 'm1', label: 'شهري', days: 30, price: 100, maxDev: 3 },
    { id: 'm3', label: '3 أشهر', days: 90, price: 250, maxDev: 5 },
    { id: 'm6', label: '6 أشهر', days: 180, price: 450, maxDev: 10 },
    { id: 'm12', label: 'سنة', days: 365, price: 700, maxDev: 15 }
  ],
  router: {
    base: '',            // مثال: http://192.168.1.1  (فارغ = اكتشاف تلقائي)
    username: 'root',
    password: '',
    sessionTimeout: 3600,
    wanIf: 'wan', lanIf: 'lan',
    wifiIfaces: []       // مثال: ["wireless_default","radio0"] — فارغ = اكتشاف تلقائي
  },
  codes: [],            // [{code,plan,maxDev,expiresAt,usedBy,usedAt,created}]
  subscribers: [],      // [{id,username,plan,start,end,maxDev,devices[],active,phone}]
  requests: [],         // طلبات اشتراك [{id,username,plan,phone,at,status}]
  logs: []
};

export class Config {
  constructor(url, token) {
    this.url = url || '';
    this.token = token || '';
    this.data = structuredClone(DEFAULTS);
    this.loadedAt = 0;
    this.remote = false;
  }

  static async load(url, token) {
    const c = new Config(url, token);
    await c.refresh();
    return c;
  }

  async refresh() {
    if (!this.url) throw new Error('لا يوجد رابط إعدادات');
    const cache = store.get('config.cache');
    const headers = { 'Accept': 'application/json' };
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    let res, json = null, err = null;
    try {
      res = await fetch(this.url, { headers, cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      json = await res.json();
    } catch (e) { err = e; }
    if (json && json.app !== undefined || (json && json.plans)) {
      this.data = merge(clone(DEFAULTS), json);
      this.loadedAt = Date.now();
      this.remote = true;
      store.set('config.cache', this.data);
      store.set('config.cacheAt', this.loadedAt);
      return this.data;
    }
    // فشل الاتصال: استخدم النسخة المخزّنة إن وُجدت (العمل دون إنترنت)
    if (cache) {
      this.data = cache; this.loadedAt = store.get('config.cacheAt', 0); this.remote = false;
      throw new Error('تعذّر تحديث الإعدادات من GitHub — نعمل بالنسخة المحفوظة');
    }
    throw new Error('تعذّر تحميل ملف الإعدادات: ' + (err ? err.message : 'ملف غير صالح'));
  }

  get plans()   { return this.data.plans || []; }
  get router()  { return this.data.router || {}; }
  get settings(){ return this.data.settings || {}; }
  get codes()   { return this.data.codes || []; }
  get subscribers() { return this.data.subscribers || []; }
  get requests(){ return this.data.requests || []; }
  plan(id)     { return this.plans.find(p => p.id === id) || null; }
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function merge(base, over) {
  if (Array.isArray(over)) return clone(over);
  if (over && typeof over === 'object') {
    const out = Array.isArray(base) ? [] : { ...base };
    for (const k of Object.keys(over)) {
      out[k] = (k in (base || {})) ? merge(base[k], over[k]) : clone(over[k]);
    }
    return out;
  }
  return over === undefined ? base : over;
}
export { merge, clone };
