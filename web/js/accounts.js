/* WiFi Hub — الحسابات والاشتراكات والأكواد
 * الواجهة الخلفية = GitHub فقط (لا سيرفر):
 *   - القراءة : raw.githubusercontent.com (أو رابط خاص + توكن قراءة)
 *   - الكتابة : GitHub Contents API (توكن الكتابة، في تطبيق المدير فقط)
 */

import { store, randomCode, now } from './util.js';

const API = 'https://api.github.com';

export class Accounts {
  constructor(cfg) {
    this.cfg = cfg;
    this.writeToken = store.get('gh.writeToken', '');
    this.repo = null;   // {owner, repo, path, branch}
  }

  /* استخراج owner/repo/path من رابط الإعدادات */
  parseRepo(url) {
    const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (m) return { owner: m[1], repo: m[2], branch: m[3], path: m[4] };
    const raw = String(url || '').match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (raw) return { owner: raw[1], repo: raw[2], branch: raw[3], path: raw[4] };
    return null;
  }

  setWriteToken(t) { this.writeToken = (t || '').trim(); store.set('gh.writeToken', this.writeToken); }

  /* قراءة محتوى ملف من GitHub */
  async readFile(path) {
    const r = this.repo || (this.repo = this.parseRepo(this.cfg.url));
    if (!r) throw new Error('رابط الإعدادات غير صالح');
    const url = `${API}/repos/${r.owner}/${r.repo}/contents/${r.path}?ref=${r.branch}`;
    const headers = { 'Accept': 'application/vnd.github+json' };
    if (this.cfg.token) headers['Authorization'] = 'Bearer ' + this.cfg.token;
    const res = await fetch(url, { headers, cache: 'no-store' });
    if (!res.ok) throw new Error('تعذّر قراءة الملف من GitHub (' + res.status + ')');
    const j = await res.json();
    const txt = j.content ? atob(j.content.replace(/\n/g, '')) : (j.download_url ? await (await fetch(j.download_url)).text() : '{}');
    return { data: JSON.parse(txt), sha: j.sha };
  }

  /* كتابة/تحديث ملف JSON في GitHub */
  async writeFile(data, pathOverride) {
    if (!this.writeToken) throw new Error('لا يوجد توكن الكتابة — أدخله في وضع المدير');
    const r = this.repo || (this.repo = this.parseRepo(this.cfg.url));
    if (!r) throw new Error('رابط الإعدادات غير صالح');
    const path = pathOverride || r.path;
    const url = `${API}/repos/${r.owner}/${r.repo}/contents/${path}`;
    const headers = {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + this.writeToken
    };
    let sha = null;
    try { const cur = await this.readFile(path); sha = cur.sha; } catch (e) {}
    const body = {
      message: 'wifihub: تحديث الإعدادات ' + new Date().toISOString(),
      content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2)))),
      branch: r.branch
    };
    if (sha) body.sha = sha;
    const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const t = await res.text();
      throw new Error('تعذّر الكتابة على GitHub (' + res.status + '): ' + t.slice(0, 160));
    }
    return true;
  }

  /* ---------- الاشتراكات ---------- */
  findSubscriber(username) {
    const un = String(username || '').trim().toLowerCase();
    return this.cfg.subscribers.find(s => String(s.username).toLowerCase() === un) || null;
  }

  /* طلب اشتراك من مشترك — يُحفظ في hub.json (يكتب المدير) أو يُرسل عبر واتساب */
  async requestSubscription({ username, plan, phone, cfg }) {
    const req = {
      id: 'rq' + now().toString(36),
      username, plan, phone: phone || '', at: now(), status: 'pending'
    };
    if (cfg.settings.autoApprove && this.writeToken) {
      const data = await this.readFile().then(x => x.data);
      data.requests = data.requests || [];
      data.requests.unshift(req);
      await this.writeFile(data);
      req.status = 'approved';
      return req;
    }
    return req;
  }

  /* تفعيل كود اشتراك */
  async redeem(code, username, cfg) {
    const c = (cfg.codes || []).find(x => String(x.code).toUpperCase() === String(code).trim().toUpperCase());
    if (!c) throw new Error('الكود غير صالح');
    if (c.usedBy) throw new Error('هذا الكود مُستخدم مسبقاً');
    if (c.expiresAt && c.expiresAt < now()) throw new Error('انتهت صلاحية الكود');
    const plan = cfg.plans.find(p => p.id === c.plan);
    if (!plan) throw new Error('باقة غير معروفة');
    return { code: c, plan };
  }

  /* توليد أكواد (المدير) */
  static genCodes(count, plan, maxDev, expiresAt) {
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push({
        code: 'WH-' + randomCode(5) + '-' + randomCode(5),
        plan, maxDev, price: 0,
        created: now(), expiresAt: expiresAt || 0,
        usedBy: '', usedAt: 0
      });
    }
    return out;
  }
}
