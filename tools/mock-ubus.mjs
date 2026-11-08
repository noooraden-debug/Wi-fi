#!/usr/bin/env node
/* خادم ubus وهمي لاختبار المحرك بدون راوتر حقيقي.
 * التشغيل: node tools/mock-ubus.mjs [port]
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 8099);
const USER = 'root';
let PASS = 'testpass';

const wireless = {
  'wireless.default': { '.type': 'wifi-iface', 'network': 'lan', 'ssid': 'MyHomeWiFi', 'encryption': 'psk2', 'key': 'oldpass123' },
  'wireless.radio0': { '.type': 'wifi-device', 'channel': '11', 'band': '2g' },
  'wireless.radio1': { '.type': 'wifi-device', 'channel': '36', 'band': '5g' },
  'wireless.guest': { '.type': 'wifi-iface', 'network': 'guest', 'ssid': 'MyHomeWiFi', 'encryption': 'psk2', 'key': 'oldpass123' }
};

let firewall = { 'firewall.@zone[1]': { '.type': 'zone', name: 'lan' } };
let dhcp = { 'dhcp.@dnsmasq[0]': { '.type': 'dnsmasq' } };

const clients = [
  { mac: 'A4:83:E7:21:9B:10', rx_bytes: 2147483648, tx_bytes: 2254857830, signal: -55 },
  { mac: 'B8:27:EB:5C:44:21', rx_bytes: 1288490188, tx_bytes: 1241513984, signal: -67 }
];

function ok(id, result) { return { jsonrpc: '2.0', id, result }; }
function err(id, message) { return { jsonrpc: '2.0', id, error: { code: -32000, message } }; }

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST') { res.end(JSON.stringify(err(0, 'POST only'))); return; }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let m; try { m = JSON.parse(body); } catch (e) { res.end(JSON.stringify(err(0, 'bad json'))); return; }
    const [sid, obj, method, args] = m.params || [];
    const id = m.id;

    if (obj === 'session' && method === 'login') {
      if (args.username !== USER || args.password !== PASS) {
        res.end(JSON.stringify(ok(id, [6, { message: 'Login failed' }]))); return;
      }
      res.end(JSON.stringify(ok(id, [0, { ubus_rpc_session: 'SESS123', timeout: 3600, acls: {} }])));
      return;
    }
    if (obj === 'session' && method === 'list') {
      res.end(JSON.stringify(ok(id, [0, {
        'hostapd.wlan0': { 'get_clients': {} },
        'hostapd.wlan1': { 'get_clients': {} },
        'iwinfo': { 'assoclist': {} },
        'system': { 'board': {}, 'info': {}, 'uptime': {} },
        'file': { 'read': {}, 'exec': {} },
        'uci': { 'get': {}, 'set': {}, 'commit': {}, 'delete': {} },
        'dhcp': { 'ipv4leases': {} }
      }])));
      return;
    }
    if (obj === 'system' && method === 'board') {
      res.end(JSON.stringify(ok(id, [0, { model: 'Mock Router', release: { description: 'OpenWrt 23.05' } }])));
      return;
    }
    if (obj === 'system' && method === 'info') {
      res.end(JSON.stringify(ok(id, [0, { uptime: 3600, memory: { total: 131072, free: 65536 } }])));
      return;
    }
    if (obj === 'system' && method === 'uptime') { res.end(JSON.stringify(ok(id, [0, 3600]))); return; }
    if (obj === 'file' && method === 'read') {
      if (args.path === '/etc/dhcp.leases') {
        const ts = Math.floor(Date.now() / 1000);
        res.end(JSON.stringify(ok(id, [0, { data: `${ts} a4:83:e7:21:9b:10 192.168.1.31 GalaxyS23 *\n${ts} b8:27:eb:5c:44:21 192.168.1.32 iPhone14 *\n` }])));
        return;
      }
      res.end(JSON.stringify(ok(id, [0, { data: '' }])));
      return;
    }
    if (obj === 'hostapd.wlan0' && method === 'get_clients') {
      res.end(JSON.stringify(ok(id, [0, { clients }])));
      return;
    }
    if (obj === 'hostapd.wlan1' && method === 'get_clients') { res.end(JSON.stringify(ok(id, [0, { clients: [] }]))); return; }
    if (obj === 'hostapd.wlan0' && method === 'del_client') { res.end(JSON.stringify(ok(id, [0, {}]))); return; }
    if (obj === 'uci' && method === 'get') {
      const cfg = args.config === 'wireless' ? wireless : args.config === 'firewall' ? firewall : dhcp;
      const values = {};
      for (const k of Object.keys(cfg)) values[k] = cfg[k];
      res.end(JSON.stringify(ok(id, [0, { values }])));
      return;
    }
    if (obj === 'uci' && method === 'set') {
      const store = args.config === 'wireless' ? wireless : args.config === 'firewall' ? firewall : dhcp;
      // محاكاة UCI الحقيقية: القسم يُحدَّث باسمه المجرّد داخل الحزمة
      const key = Object.keys(store).find(k => k.split('.').slice(1).join('.') === args.section
        || k === args.section) || (args.config + '.' + args.section);
      store[key] = { ...(store[key] || {}), ...args.values };
      res.end(JSON.stringify(ok(id, [0, {}])));
      return;
    }
    if (obj === 'uci' && method === 'delete') {
      const store = args.config === 'wireless' ? wireless : args.config === 'firewall' ? firewall : dhcp;
      const key = Object.keys(store).find(k => k.split('.').slice(1).join('.') === args.section || k === args.section);
      if (key) delete store[key];
      res.end(JSON.stringify(ok(id, [0, {}])));
      return;
    }
    if (obj === 'uci' && method === 'commit') { res.end(JSON.stringify(ok(id, [0, {}]))); return; }
    if (obj === 'file' && method === 'exec') {
      const cmd = (args.command || '') + ' ' + (args.params || []).join(' ');
      let stdout = '', stderr = '';
      if (/chpasswd/.test(cmd)) {
        const quoted = [...cmd.matchAll(/'([^']+)'/g)].map(x => x[1]).filter(x => !x.startsWith('root:'));
        if (quoted.length) { PASS = quoted[0]; stdout = 'CHPASSWD_OK\n'; }
        else stderr = 'parse error\n';
      } else if (/passwd/.test(cmd)) {
        const m = cmd.match(/'([^']{3,})'/);
        if (m) { PASS = m[1]; stdout = 'PASSWD_OK\n'; }
      } else stdout = '';
      res.end(JSON.stringify(ok(id, [0, { code: 0, stdout, stderr }])));
      return;
    }

    res.end(JSON.stringify(err(id, 'Unknown object/method: ' + obj + '.' + method)));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log('mock ubus on http://127.0.0.1:' + PORT));
