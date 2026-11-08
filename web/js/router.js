/* WiFi Hub — طبقة التحكم بالراوتر (OpenWrt / ubus) — بلا root وبلا سيرفر */

import { Bridge, Ubus } from './ubus.js';

const CANDIDATES = [
  'http://192.168.1.1', 'http://192.168.0.1', 'http://192.168.31.1',
  'http://192.168.8.1', 'http://192.168.2.1', 'http://10.0.0.1',
  'http://192.168.3.1', 'http://10.0.0.1:8080'
];

const macKey = m => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');

export class Router {
  constructor(cfg) {
    this.cfg = cfg || {};
    this.ubus = null;
    this.base = '';
    this.connected = false;
    this.lastError = '';
  }

  /* ---------- الاتصال ---------- */
  async connect() {
    const list = [];
    if (this.cfg.base) list.push(this.cfg.base);
    const gw = Bridge.gateway();
    if (gw) list.push('http://' + gw);
    for (const c of CANDIDATES) list.push(c);

    const seen = new Set();
    let lastErr = '';
    for (const base of list) {
      const b = base.replace(/\/+$/, '');
      if (seen.has(b)) continue;
      seen.add(b);
      const u = new Ubus(b);
      try {
        await u.login(this.cfg.username || 'root', this.cfg.password || '');
        this.ubus = u; this.base = b; this.connected = true; this.lastError = '';
        return b;
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
    this.connected = false;
    this.lastError = lastErr || 'تعذّر الوصول إلى الراوتر';
    throw new Error(this.lastError);
  }

  async ensure() {
    if (this.connected && this.ubus && this.ubus.sid) return this.ubus;
    return (await this.connect()), this.ubus;
  }

  async disconnect() {
    if (this.ubus) await this.ubus.logout();
    this.connected = false;
  }

  /* ---------- معلومات عامة ---------- */
  async board() {
    const u = await this.ensure();
    try { return await u.call('system', 'board', {}); } catch (e) { return {}; }
  }

  async info() {
    const u = await this.ensure();
    const out = {};
    try { out.sys = await u.call('system', 'info', {}); } catch (e) {}
    try { out.uptime = await u.call('system', 'uptime', {}); } catch (e) {}
    return out;
  }

  /* ---------- الواي فاي ---------- */
  async wirelessSections() {
    const u = await this.ensure();
    let raw = null;
    try { raw = await u.call('uci', 'get', { config: 'wireless' }); } catch (e) {}
    if (!raw) { try { raw = await u.call('uci', 'get', { config: 'wireless' }); } catch (e) { return []; } }
    const vals = (raw && raw.values) || {};
    return Object.keys(vals).filter(k => /^([\w-]+\.)?\w+=/.test(k) || /=/.test(k))
      .map(k => {
        const name = k.includes('.') ? k.split('.')[1] : k;
        return { name, v: vals[k] };
      });
  }

  async wifiState() {
    const u = await this.ensure();
    let raw = null;
    try { raw = await u.call('uci', 'get', { config: 'wireless' }); } catch (e) { raw = null; }
    const vals = (raw && raw.values) || {};
    const ifaces = [];
    const radios = {};
    for (const k of Object.keys(vals)) {
      const name = k.includes('.') ? k.split('.')[1] : k;
      const sec = vals[k] || {};
      if (sec['.type'] === 'wifi-device') radios[name] = sec;
      else if (sec['.type'] === 'wifi-iface') ifaces.push({ name, ...sec });
    }
    let ssid = '', enc = '', key = '';
    if (ifaces.length) {
      ssid = ifaces[0].ssid || '';
      enc = ifaces[0].encryption || '';
      key = ifaces[0].key || '';
    }
    const channels = Object.values(radios).map(r => r.channel || '').filter(Boolean);
    const disabled = Object.values(radios).some(r => r.disabled === '1');
    return { ssid, encryption: enc, hasKey: !!key, ifaces, radios, channels, disabled };
  }

  /* تغيير اسم الشبكة وكلمة المرور — عبر UCI ثم إعادة تحميل */
  async wifiSet({ ssid, password, band }) {
    const u = await this.ensure();
    const st = await this.wifiState();
    if (!st.ifaces.length) throw new Error('لم يتم العثور على واجهة واي فاي');
    const targets = band === '2g'
      ? st.ifaces.filter(i => /2\.4|24ghz|ra0|g|wlan0/i.test(i.device || '') || String(i.name).includes('default'))
      : band === '5g'
        ? st.ifaces.filter(i => /5ghz|5g|radios?1|wan/i.test(i.device || ''))
        : st.ifaces;
    const list = targets.length ? targets : st.ifaces;

    for (const it of list) {
      if (ssid) await u.call('uci', 'set', { config: 'wireless', section: it.name, values: { ssid } });
      if (password) {
        await u.call('uci', 'set', { config: 'wireless', section: it.name, values: { key: password } });
        const enc = (it.encryption || '').split(',').map(s => s.trim());
        const need = enc.filter(x => x && x !== 'none');
        if (!need.length) await u.call('uci', 'set', { config: 'wireless', section: it.name, values: { encryption: 'psk2' } });
      }
    }
    await u.call('uci', 'commit', { config: 'wireless' });
    await this.reloadWifi();
    return { ok: true, updated: list.map(i => i.name) };
  }

  async reloadWifi() {
    const u = await this.ensure();
    const tries = [
      ['/sbin/wifi', ['reload']],
      ['/bin/sh', ['-c', 'wifi reload >/dev/null 2>&1']],
      ['/sbin/ifup', ['-a']]
    ];
    for (const [cmd, args] of tries) {
      try { await u.exec(cmd, args, 30); return true; } catch (e) {}
    }
    try { await u.call('network.wireless', 'reload', {}); return true; } catch (e) {}
    return false;
  }

  /* ---------- الأجهزة ---------- */
  async clients() {
    const u = await this.ensure();
    const out = [];
    const seen = new Map();

    /* 1) سجلleases الـ DHCP */
    try {
      const r = await u.call('file', 'read', { path: '/etc/dhcp.leases' });
      const txt = (r && r.data) || '';
      for (const line of String(txt).split('\n')) {
        const p = line.trim().split(/\s+/);
        if (p.length < 4) continue;
        const [expiry, mac, ip, name] = p;
        const key = macKey(mac);
        if (seen.has(key)) continue;
        seen.set(key, {
          mac: mac.toLowerCase(), ip, name: name === '*' ? '' : name,
          expiry: Number(expiry) * 1000, rx: 0, tx: 0, signal: null, connected: false, source: 'dhcp'
        });
      }
    } catch (e) {}

    /* 2) قائمة hostapd (المتصلون فعلياً + الإحصاءات) */
    let radios = [];
    try {
      const l = await u.list();
      radios = Object.keys(l).filter(k => k.startsWith('hostapd.'));
    } catch (e) {}
    for (const r of radios) {
      try {
        const c = await u.call(r, 'get_clients', {});
        const arr = (c && c.clients) || [];
        for (const cl of arr) {
          const key = macKey(cl.mac);
          const cur = seen.get(key);
          const rec = cur || {
            mac: cl.mac.toLowerCase(), ip: '', name: '', expiry: 0, rx: 0, tx: 0, signal: null, source: 'hostapd'
          };
          rec.rx = cl.rx_bytes || rec.rx || 0;
          rec.tx = cl.tx_bytes || rec.tx || 0;
          rec.signal = (cl.signal != null) ? cl.signal : rec.signal;
          rec.connected = true;
          rec.radio = r.split('.')[1];
          if (cl.rx_rate || cl.tx_rate) rec.speed = ((cl.rx_rate || 0) + (cl.tx_rate || 0));
          seen.set(key, rec);
        }
      } catch (e) {}
    }

    /* 3) iwinfo كبديل */
    if (!seen.size) {
      try {
        const devs = await u.call('iwinfo', 'devices', {});
        for (const d of (devs && devs.devices) || []) {
          const a = await u.call('iwinfo', 'assoclist', { device: d });
          for (const cl of (a && a.results) || []) {
            const key = macKey(cl.mac);
            if (seen.has(key)) continue;
            seen.set(key, {
              mac: cl.mac.toLowerCase(), ip: '', name: '', expiry: 0,
              rx: cl.rx_bytes || 0, tx: cl.tx_bytes || 0, signal: cl.signal || null,
              connected: true, source: 'iwinfo', radio: d
            });
          }
        }
      } catch (e) {}
    }

    out.push(...seen.values());
    out.forEach(d => {
      d.type = guessType(d);
      d.usage = (Number(d.rx) || 0) + (Number(d.tx) || 0);
      d.online = !!d.connected || (d.expiry && d.expiry > Date.now());
    });
    out.sort((a, b) => (b.usage || 0) - (a.usage || 0));
    return out;
  }

  /* ---------- التحكم بالأجهزة ---------- */
  /* تثبيت IP ثابت للجهاز ثم منعه بقاعدة فايروول (يبقى بعد إعادة تشغيل الراوتر) */
  async blockDevice(mac, ip) {
    const u = await this.ensure();
    const key = macKey(mac);
    if (!ip) throw new Error('لا يوجد IP لهذا الجهاز');
    const fw = 'hubblk' + key.slice(-8);
    const dh = 'hubpin' + key.slice(-8);
    try { await u.call('uci', 'delete', { config: 'firewall', section: fw }); } catch (e) {}
    await u.call('uci', 'set', { config: 'firewall', section: fw, values: {
      name: 'HubBlock-' + key.slice(-6), src: 'lan', src_ip: ip, dest: '*', target: 'REJECT', proto: 'all'
    } });
    await u.call('uci', 'commit', { config: 'firewall' });
    /* تثبيت العنوان حتى لا يأخذ جهازاً آخر عنوانه */
    try {
      await u.call('uci', 'delete', { config: 'dhcp', section: dh });
      await u.call('uci', 'set', { config: 'dhcp', section: dh, values: {
        name: 'HubPin-' + key.slice(-6), mac: mac.toLowerCase(), ip: ip, leasetime: '12h'
      } });
      await u.call('uci', 'commit', { config: 'dhcp' });
    } catch (e) {}
    await this.reloadFirewall();
    await this.kick(mac);
    return { ok: true, ip };
  }

  async unblockDevice(mac) {
    const u = await this.ensure();
    const key = macKey(mac);
    for (const sec of ['hubblk' + key.slice(-8)]) {
      try { await u.call('uci', 'delete', { config: 'firewall', section: sec }); } catch (e) {}
    }
    try { await u.call('uci', 'commit', { config: 'firewall' }); } catch (e) {}
    await this.reloadFirewall();
    return { ok: true };
  }

  async renameDevice(mac, name) {
    const u = await this.ensure();
    const key = macKey(mac);
    const dh = 'hubpin' + key.slice(-8);
    try { await u.call('uci', 'delete', { config: 'dhcp', section: dh }); } catch (e) {}
    await u.call('uci', 'set', { config: 'dhcp', section: dh, values: {
      name: name, mac: mac.toLowerCase()
    } });
    await u.call('uci', 'commit', { config: 'dhcp' });
    return { ok: true };
  }

  /* فصل الجهاز الآن من الواي فاي */
  async kick(mac) {
    const u = await this.ensure();
    try {
      const l = await u.list();
      for (const r of Object.keys(l).filter(k => k.startsWith('hostapd.'))) {
        try { await u.call(r, 'del_client', { mac, reason: 5, deauth: true, ban_time: 3600 }); } catch (e) {}
      }
    } catch (e) {}
    return { ok: true };
  }

  async reloadFirewall() {
    const u = await this.ensure();
    const tries = [
      ['/sbin/fw4', ['reload']],
      ['/bin/sh', ['-c', '/etc/init.d/firewall restart >/dev/null 2>&1']],
      ['/sbin/service', ['firewall', 'restart']]
    ];
    for (const [cmd, args] of tries) {
      try { await u.exec(cmd, args, 40); return true; } catch (e) {}
    }
    return false;
  }

  async reboot() {
    const u = await this.ensure();
    try { await u.exec('/sbin/reboot', [], 10); } catch (e) { await u.execShell('reboot'); }
    return { ok: true };
  }

  /* ---------- تغيير كلمة مرور دخول الراوتر (بدون SSH ولا root على الهاتف) ---------- */
  async setAdminPassword(newPass, user = 'root') {
    if (!newPass || newPass.length < 5) throw new Error('كلمة المرور قصيرة (5 أحرف على الأقل)');
    const u = await this.ensure();
    const q = s => "'" + String(s).replace(/'/g, `'\\''`) + "'";
    const p = q(newPass);
    const attempts = [
      `printf 'root:%s\\n' ${p} | chpasswd 2>/dev/null && echo CHPASSWD_OK`,
      `echo ${p} | passwd ${q(user)} 2>/dev/null && echo PASSWD_OK`,
      `(echo ${p}; echo ${p}) | passwd ${q(user)} 2>/dev/null && echo PASSWD_OK2`
    ];
    let done = false, lastErr = '';
    for (const cmd of attempts) {
      try {
        const r = await u.execShell(cmd, 25);
        const out = ((r && r.stdout) || '') + ((r && r.stderr) || '');
        if (/OK/.test(out)) { done = true; break; }
        lastErr = out.slice(0, 120);
      } catch (e) { lastErr = e.message; }
    }
    if (!done) throw new Error('تعذّر تغيير كلمة المرور على الراوتر ' + (lastErr ? '(' + lastErr + ')' : ''));
    /* تأكيد فعلي: تسجيل دخول جديد بكلمة المرور الجديدة */
    const check = new Ubus(this.base);
    await check.login(user, newPass);
    return { ok: true, verified: true };
  }


  /* تنفيذ أمر حر (للمدير المتقدم) */
  async shell(cmd) { const u = await this.ensure(); return await u.execShell(cmd, 40); }
}

/* تقدير نوع الجهاز من الـ MAC والاسم */
function guessType(d) {
  const s = ((d.name || '') + ' ' + (d.mac || '')).toLowerCase();
  if (/iphone|ipad|android|pixel|samsung|galaxy|xiaomi|redmi|oneplus|oppo|huawei|phone|mobile|realme/.test(s)) return 'phone';
  if (/macbook|imac|windows|pc|desktop|laptop|thinkpad|asus|acer|hp |dell/.test(s)) return 'laptop';
  if (/tv|chromecast|firetv|roku|apple ?tv|smart/.test(s)) return 'tv';
  if (/echo|alexa|sonos|google|nest|home|assistant|doorbell|camera|ipcam|plug/.test(s)) return 'iot';
  if (/watch|band|fitness/.test(s)) return 'wearable';
  if (/printer|hp|epson|canon/.test(s)) return 'printer';
  return 'other';
}
export { guessType };
