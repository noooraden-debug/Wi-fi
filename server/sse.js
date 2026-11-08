/* WiFi Hub — قناة الأحداث اللحظية (SSE)
 * تربط لوحة الإدارة بالمشتركين لحظياً: أي تغيير (تفعيل، كود، طلب) يصل فوراً
 * لكل المتصلين دون انتظار أي استطلاع دوري.
 */

const clients = new Map();   /* id -> {res, username, role} */

export function addClient(id, res, username, role) {
  clients.set(id, { res, username, role });
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
  } catch (e) { clients.delete(id); }
}

export function removeClient(id) { clients.delete(id); }
export const clientCount = () => clients.size;

/* بثّ للجميع */
export function broadcast(type, data = {}) {
  const payload = `data: ${JSON.stringify({ type, ...data, at: Date.now() })}\n\n`;
  for (const [id, c] of clients) {
    try { c.res.write(payload); }
    catch (e) { clients.delete(id); }
  }
}

/* بثّ لمستخدم بعينه */
export function toUser(username, type, data = {}) {
  const payload = `data: ${JSON.stringify({ type, ...data, at: Date.now() })}\n\n`;
  for (const [id, c] of clients) {
    if (String(c.username).toLowerCase() !== String(username).toLowerCase()) continue;
    try { c.res.write(payload); } catch (e) { clients.delete(id); }
  }
}

/* نبضة للحفاظ على الاتصال */
export function startHeartbeat(interval = 25000) {
  const t = setInterval(() => {
    for (const [id, c] of clients) {
      try { c.res.write(': ping\n\n'); } catch (e) { clients.delete(id); }
    }
  }, interval);
  t.unref?.();
  return t;
}
