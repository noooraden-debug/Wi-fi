/* WiFi Hub — جسر الاتصال + عميل ubus
 *
 * التطبيق الأصلي (Android) يوفّر جسراً محلياً يتجاوز قيود CORS للمتصفح،
 * لأن مteinدر ubus في OpenWrt لا يفعّل CORS إلا بإعداد root في uhttpd.
 * في المتصفح (وضع المعاينة) نستخدم fetch مباشرة.
 */

export const Bridge = {
  get native() { return !!(globalThis.WiFiHub && typeof globalThis.WiFiHub.http === 'function'); },

  /* طلب HTTP. يعيد {status, body, error} */
  async http(url, method = 'GET', body = null, headers = {}) {
    if (this.native) {
      const h = Object.assign({ 'Content-Type': 'application/json' }, headers);
      try {
        const r = globalThis.WiFiHub.http(url, method, body == null ? '' : body, JSON.stringify(h));
        const j = JSON.parse(r);
        if (j && j.error) return { status: 0, body: '', error: j.error };
        return { status: j.status || 0, body: j.body || '', error: null };
      } catch (e) {
        return { status: 0, body: '', error: String(e && e.message || e) };
      }
    }
    try {
      const opt = { method, headers, cache: 'no-store' };
      if (body != null) opt.body = body;
      const res = await fetch(url, opt);
      const text = await res.text();
      return { status: res.status, body: text, error: null };
    } catch (e) {
      return { status: 0, body: '', error: String(e && e.message || e) };
    }
  },

  /* معلومات الشبكة من الجهاز (البوابة الافتراضية = غالباً الراوتر) */
  gateway() {
    if (this.native && typeof globalThis.WiFiHub.gateway === 'function') {
      try { return globalThis.WiFiHub.gateway() || ''; } catch (e) {}
    }
    return '';
  }
};

/* ============================ ubus ============================ */
export class Ubus {
  constructor(base) {
    this.base = base.replace(/\/+$/, '');
    this.sid = null;
    this.rpcId = 0;
    this.objects = null;
  }

  async rpc(sid, obj, method, args) {
    const id = ++this.rpcId;
    const payload = {
      jsonrpc: '2.0', id,
      method: 'call',
      params: [sid || '00000000000000000000000000000000', obj, method, args || {}]
    };
    const r = await Bridge.http(this.base + '/ubus', 'POST', JSON.stringify(payload), {
      'Content-Type': 'application/json'
    });
    if (r.error) throw new Error(r.error);
    if (r.status !== 200) throw new Error('استجابة غير متوقعة من الراوتر (' + r.status + ')');
    let j;
    try { j = JSON.parse(r.body); } catch (e) { throw new Error('رد غير صالح من الراوتر'); }
    if (j.error) throw new Error(j.error.message || 'خطأ ubus');
    const res = j.result;
    if (!Array.isArray(res)) throw new Error('رد ubus غير متوقع');
    const [rc, data] = res;
    if (rc !== 0) {
      const msg = (data && (data.message || data.error)) || ('رمز خطأ ' + rc);
      throw new Error(msg);
    }
    return data === undefined ? null : data;
  }

  async login(user, pass) {
    const d = await this.rpc('00000000000000000000000000000000', 'session', 'login',
      { username: user, password: pass, timeout: 3600 });
    if (!d || !d.ubus_rpc_session) throw new Error('فشل تسجيل الدخول إلى الراوتر');
    this.sid = d.ubus_rpc_session;
    this.timeout = d.timeout || 3600;
    return d;
  }

  call(obj, method, args) { return this.rpc(this.sid, obj, method, args); }

  /* تنفيذ أمر على الراوتر عبر rpcd (file exec) — مفيد للتطبيقات التي لا توفّر ubus */
  async exec(cmd, params = [], timeout = 25) {
    return this.call('file', 'exec', { command: cmd, params, timeout });
  }

  async execShell(script, timeout = 25) {
    return this.exec('/bin/sh', ['-c', script], timeout);
  }

  async list() {
    if (this.objects) return this.objects;
    try { this.objects = await this.rpc(this.sid, 'session', 'list', {}); }
    catch (e) { this.objects = {}; }
    return this.objects;
  }

  async logout() {
    if (!this.sid) return;
    try { await this.call('session', 'destroy', {}); } catch (e) {}
    this.sid = null;
  }
}
