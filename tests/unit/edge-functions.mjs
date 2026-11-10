// Запуск Edge Functions turn-credentials и turn-check в Node: подменяем Deno.serve/env/connect и fetch.
// Запуск: node --experimental-strip-types tests/unit/edge-functions.mjs
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-'));
function stage(name) {
  const dir = path.join(tmp, name);
  fs.cpSync(path.join(ROOT, 'supabase/functions', name), dir, { recursive: true });
  fs.renameSync(path.join(dir, 'index.ts'), path.join(dir, 'index.mts'));
  return pathToFileURL(path.join(dir, 'index.mts')).href;
}

let ENV = {};
let handler = null;
const realFetch = globalThis.fetch;
const calls = [];
let rest = {};          // путь → ответ
globalThis.Deno = {
  env: { get: (k) => ENV[k] },
  serve: (h) => { handler = h; },
  connect: ({ hostname, port }) => new Promise((res, rej) => {
    const s = net.connect(port, hostname, () => res({
      write: (b) => new Promise((r) => s.write(b, () => r(b.length))),
      read: (buf) => new Promise((r) => { const take = (d) => { buf.set(d.subarray(0, buf.length)); r(Math.min(d.length, buf.length)); };
        if (q.length) take(q.shift()); else w = (d) => (d ? take(d) : r(null)); }),
      close: () => s.destroy(),
    }));
    const q = []; let w = null;
    s.on('data', (d) => { if (w) { const x = w; w = null; x(d); } else q.push(d); });
    s.on('end', () => { if (w) { const x = w; w = null; x(null); } });
    s.on('error', rej);
  }),
};
globalThis.fetch = async (url, init = {}) => {
  url = String(url); calls.push({ url, init });
  if (url.endsWith('/auth/v1/user')) {
    return init.headers.Authorization === 'Bearer good-token' ? new Response(JSON.stringify({ id: 'u-1' })) : new Response('{}', { status: 401 });
  }
  for (const [k, v] of Object.entries(rest)) if (url.includes(k)) return typeof v === 'function' ? v(url, init) : new Response(JSON.stringify(v));
  return new Response('not found', { status: 404 });
};
const req = (token, extra = '') => new Request('https://x/functions/v1/f' + extra, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {} });

// ---------- turn-credentials ----------
await import(stage('turn-credentials'));
const creds = handler;
ENV = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
let r = await creds(new Request('https://x', { method: 'OPTIONS' }));
assert.equal(r.status, 204, 'CORS preflight');
assert.equal(r.headers.get('access-control-allow-origin'), '*');
r = await creds(req(null)); assert.equal(r.status, 401, 'без токена');
r = await creds(req('bad')); assert.equal(r.status, 401, 'чужой токен');
rest = { 'turn_providers': [] };
r = await creds(req('good-token')); assert.equal(r.status, 503, 'TURN не настроен');
ENV.TURN_URLS = 'turn:relay1.expressturn.com:3478, turn:relay1.expressturn.com:3478?transport=tcp, http://bad';
ENV.TURN_USERNAME = 'main-user'; ENV.TURN_PASSWORD = 'main-pass';
r = await creds(req('good-token')); let j = await r.json();
assert.equal(r.status, 200);
assert.deepEqual(j.iceServers[0], { urls: ['turn:relay1.expressturn.com:3478', 'turn:relay1.expressturn.com:3478?transport=tcp'], username: 'main-user', credential: 'main-pass' }, 'основной TURN');
rest = { 'turn_providers': Array.from({ length: 5 }, (_, i) => ({ urls: ['turn:p' + i + '.example.com'], username: 'p' + i, credential: 'c' + i })) };
r = await creds(req('good-token')); j = await r.json();
assert.equal(j.iceServers.length, 4, 'основной + 3 партнёра'); assert.equal(j.partners, 3);
const q = calls.filter((c) => c.url.includes('turn_providers')).pop();
assert.match(q.url, /status=eq\.active&last_ok=gt\./, 'только проверенные партнёры');
assert.equal(q.init.headers.apikey, 'svc');
delete ENV.TURN_USERNAME;
r = await creds(req('good-token')); j = await r.json();
assert.equal(j.iceServers.length, 3, 'без основного — только партнёры');
console.log('turn-credentials: ok');

// ---------- turn-check против поддельного TURN ----------
const { default: crypto } = await import('node:crypto');
const turn = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 20 && buf.length >= 20 + buf.readUInt16BE(2)) {
      const m = buf.subarray(0, 20 + buf.readUInt16BE(2)); buf = buf.subarray(m.length);
      const tid = m.subarray(8, 20), has = (t) => { for (let o = 20; o < m.length;) { if (m.readUInt16BE(o) === t) return m.subarray(o + 4, o + 4 + m.readUInt16BE(o + 2)); o += 4 + m.readUInt16BE(o + 2) + ((4 - m.readUInt16BE(o + 2) % 4) % 4); } return null; };
      const out = (type, attrs) => { const body = Buffer.concat(attrs.map(([t, v]) => { const p = (4 - v.length % 4) % 4; const b = Buffer.alloc(4 + v.length + p); b.writeUInt16BE(t); b.writeUInt16BE(v.length, 2); v.copy(b, 4); return b; }));
        const hd = Buffer.alloc(20); hd.writeUInt16BE(type); hd.writeUInt16BE(body.length, 2); hd.writeUInt32BE(0x2112a442, 4); tid.copy(hd, 8); sock.write(Buffer.concat([hd, body])); };
      const e401 = Buffer.from([0, 0, 4, 1]);
      const user = has(0x0006);
      if (!user) { out(0x0113, [[0x0009, e401], [0x0014, Buffer.from('r')], [0x0015, Buffer.from('n')]]); continue; }
      const ok = String(user) === 'good';
      if (m.readUInt16BE(0) === 0x0003) out(ok ? 0x0103 : 0x0113, ok ? [] : [[0x0009, e401], [0x0014, Buffer.from('r')], [0x0015, Buffer.from('n')]]);
      else out(0x0104, []);
    }
  });
});
await new Promise((res) => turn.listen(0, '127.0.0.1', res));
const port = turn.address().port;
const patches = [];
rest = {
  'turn_providers?id=eq.': (url, init) => {
    if (init.method === 'PATCH') { patches.push(JSON.parse(init.body)); return new Response('[]'); }
    return new Response(JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', urls: [`turn:127.0.0.1:${port}`], username: url.includes('1111') ? 'good' : 'bad', credential: 'x', status: 'pending', last_check: null }]));
  },
  'rpc/refresh_partners': () => new Response(null, { status: 204 }),
};
await import(stage('turn-check'));
const check = handler;
r = await check(req(null, '?id=11111111-1111-1111-1111-111111111111')); j = await r.json();
assert.equal(j.checked, 1); assert.equal(j.results[0].ok, true, 'рабочий TURN');
assert.equal(patches.pop().status, 'active');
assert.ok(calls.some((c) => c.url.includes('rpc/refresh_partners')), 'уровни пересчитаны');
rest['turn_providers?id=eq.'] = (url, init) => {
  if (init.method === 'PATCH') { patches.push(JSON.parse(init.body)); return new Response('[]'); }
  return new Response(JSON.stringify([{ id: '22222222-2222-2222-2222-222222222222', urls: [`turn:127.0.0.1:${port}`], username: 'bad', credential: 'x', status: 'active', last_check: null }]));
};
r = await check(req(null, '?id=22222222-2222-2222-2222-222222222222')); j = await r.json();
assert.equal(j.results[0].ok, false); assert.match(j.results[0].error, /неверный логин/);
assert.equal(patches.pop().status, 'failing');
r = await check(req(null, '?id=../../etc')); assert.equal(r.status, 400, 'кривой id');
turn.close();
console.log('turn-check: ok');
globalThis.fetch = realFetch;
