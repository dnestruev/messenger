// Проверка supabase/functions/turn-check/stun.js против поддельного TURN-сервера (TCP), написанного по RFC 8656.
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { checkTurn, parseTurnUrl } from '../../supabase/functions/turn-check/stun.js';

const md5 = (b) => new Uint8Array(crypto.createHash('md5').update(b).digest());
const hmacSha1 = (k, d) => new Uint8Array(crypto.createHmac('sha1', k).update(d).digest());
const open = (host, port) => new Promise((res, rej) => {
  const s = net.connect(port, host, () => res({
    write: (b) => new Promise((r) => s.write(b, r)),
    read: () => new Promise((r) => { if (queue.length) return r(queue.shift()); waiter = r; }),
    close: () => s.destroy(),
  }));
  const queue = []; let waiter = null;
  s.on('data', (d) => { const u = new Uint8Array(d); if (waiter) { const w = waiter; waiter = null; w(u); } else queue.push(u); });
  s.on('end', () => { if (waiter) { const w = waiter; waiter = null; w(null); } });
  s.on('error', rej);
});

/** Поддельный TURN: realm/nonce, проверка MESSAGE-INTEGRITY, «устаревший nonce» один раз по желанию */
function fakeTurn({ user, pass, realm = 'example.org', staleOnce = false, silent = false }) {
  const stats = { allocs: 0, refreshZero: 0 };
  let nonce = 'nonce-' + crypto.randomBytes(4).toString('hex');
  let stale = staleOnce;
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      if (silent) return;
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 20 && buf.length >= 20 + buf.readUInt16BE(2)) {
        const len = 20 + buf.readUInt16BE(2);
        handle(sock, buf.subarray(0, len)); buf = buf.subarray(len);
      }
    });
  });
  const attrs = (m) => { const out = {}; let o = 20; const end = 20 + m.readUInt16BE(2);
    while (o + 4 <= end) { const t = m.readUInt16BE(o), l = m.readUInt16BE(o + 2); out[t] = { v: m.subarray(o + 4, o + 4 + l), at: o }; o += 4 + l + ((4 - l % 4) % 4); } return out; };
  const reply = (sock, type, tid, list) => {
    const body = Buffer.concat(list.map(([t, v]) => { const pad = (4 - v.length % 4) % 4; const b = Buffer.alloc(4 + v.length + pad); b.writeUInt16BE(t); b.writeUInt16BE(v.length, 2); v.copy(b, 4); return b; }));
    const h = Buffer.alloc(20); h.writeUInt16BE(type); h.writeUInt16BE(body.length, 2); h.writeUInt32BE(0x2112a442, 4); tid.copy(h, 8);
    sock.write(Buffer.concat([h, body]));
  };
  const err = (code) => { const b = Buffer.alloc(4); b[2] = Math.floor(code / 100); b[3] = code % 100; return b; };
  function handle(sock, m) {
    const type = m.readUInt16BE(0), tid = m.subarray(8, 20), a = attrs(m);
    assert.equal(m.readUInt32BE(4), 0x2112a442, 'magic cookie');
    if (type === 0x0003) assert.ok(a[0x0019] && a[0x0019].v[0] === 17, 'REQUESTED-TRANSPORT = UDP');
    const mi = a[0x0008];
    if (!mi) return reply(sock, type | 0x0110, tid, [[0x0009, err(401)], [0x0014, Buffer.from(realm)], [0x0015, Buffer.from(nonce)]]);
    // независимая проверка подписи по RFC 5389 §15.4
    const signedPart = Buffer.from(m.subarray(0, mi.at));   // всё до атрибута MESSAGE-INTEGRITY
    signedPart.writeUInt16BE(mi.at - 20 + 24, 2);
    const key = crypto.createHash('md5').update(`${a[0x0006].v}:${realm}:${pass}`).digest();
    const good = crypto.createHmac('sha1', key).update(signedPart).digest().equals(Buffer.from(mi.v));
    if (String(a[0x0006].v) !== user || !good) return reply(sock, type | 0x0110, tid, [[0x0009, err(401)], [0x0014, Buffer.from(realm)], [0x0015, Buffer.from(nonce)]]);
    if (String(a[0x0015].v) !== nonce) return reply(sock, type | 0x0110, tid, [[0x0009, err(438)], [0x0014, Buffer.from(realm)], [0x0015, Buffer.from(nonce)]]);
    if (stale && type === 0x0003) { stale = false; nonce = 'nonce2-' + crypto.randomBytes(4).toString('hex'); return reply(sock, 0x0113, tid, [[0x0009, err(438)], [0x0014, Buffer.from(realm)], [0x0015, Buffer.from(nonce)]]); }
    if (type === 0x0003) { stats.allocs++; return reply(sock, 0x0103, tid, [[0x000d, Buffer.from([0, 0, 2, 0x58])]]); }
    if (type === 0x0004) { if (a[0x000d]?.v.readUInt32BE(0) === 0) stats.refreshZero++; return reply(sock, 0x0104, tid, []); }
  }
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ port: server.address().port, stats, close: () => server.close() })));
}

const base = { host: '127.0.0.1', tls: false, open, md5, hmacSha1 };
let srv = await fakeTurn({ user: 'alice', pass: 'Секрет-123' });
let r = await checkTurn({ ...base, port: srv.port, username: 'alice', password: 'Секрет-123' });
assert.deepEqual(r, { ok: true }, 'верный логин');
await new Promise((x) => setTimeout(x, 100));
assert.equal(srv.stats.allocs, 1); assert.equal(srv.stats.refreshZero, 1, 'выделение сразу освобождено');
r = await checkTurn({ ...base, port: srv.port, username: 'alice', password: 'не тот' });
assert.equal(r.ok, false); assert.match(r.error, /неверный логин/);
r = await checkTurn({ ...base, port: srv.port, username: 'bob', password: 'Секрет-123' });
assert.equal(r.ok, false);
srv.close();

srv = await fakeTurn({ user: 'u', pass: 'p', staleOnce: true });
r = await checkTurn({ ...base, port: srv.port, username: 'u', password: 'p' });
assert.deepEqual(r, { ok: true }, 'устаревший nonce → повтор'); srv.close();

srv = await fakeTurn({ user: 'u', pass: 'p', silent: true });
r = await checkTurn({ ...base, port: srv.port, username: 'u', password: 'p', timeoutMs: 800 });
assert.equal(r.ok, false); assert.match(r.error, /не ответил/); srv.close();

r = await checkTurn({ ...base, port: 1, username: 'u', password: 'p', timeoutMs: 800 });
assert.equal(r.ok, false, 'порт закрыт');

assert.deepEqual(parseTurnUrl('turn:relay1.expressturn.com:3478?transport=tcp'), { host: 'relay1.expressturn.com', port: 3478, tls: false });
assert.deepEqual(parseTurnUrl('turns:x.example.com'), { host: 'x.example.com', port: 5349, tls: true });
assert.equal(parseTurnUrl('http://x'), null);
console.log('turn-check: все проверки пройдены');
