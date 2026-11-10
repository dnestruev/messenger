// Edge Function «turn-check»: проверяет TURN-серверы партнёров (Allocate с паролем по TCP).
// Вызывается раз в 6 часов из pg_cron и сразу после добавления сервера (?id=…).
// verify_jwt выключен: проверка ничего не раскрывает (пароли не возвращаются), а частота ограничена.
import { createHash, createHmac } from 'node:crypto';
import { checkTurn, parseTurnUrl } from './stun.js';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
  'Content-Type': 'application/json; charset=utf-8',
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const env = (k: string) => Deno.env.get(k) ?? '';
const URL_ = env('SUPABASE_URL');
const KEY = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY');

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY, ...(KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${KEY}` }),
      'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

const md5 = (b: Uint8Array) => new Uint8Array(createHash('md5').update(b).digest());
const hmacSha1 = (k: Uint8Array, d: Uint8Array) => new Uint8Array(createHmac('sha1', k).update(d).digest());
async function open(host: string, port: number, tls: boolean) {
  const conn = tls ? await Deno.connectTls({ hostname: host, port }) : await Deno.connect({ hostname: host, port });
  return {
    write: async (b: Uint8Array) => { let o = 0; while (o < b.length) o += await conn.write(b.subarray(o)); },
    read: async () => { const buf = new Uint8Array(4096); const n = await conn.read(buf); return n === null ? null : buf.subarray(0, n); },
    close: () => { try { conn.close(); } catch { /* уже закрыт */ } },
  };
}

type Provider = { id: string; urls: string[]; username: string; credential: string; status: string; last_check: string | null };
async function checkOne(p: Provider) {
  let last = 'нет адресов';
  const seen = new Set<string>();
  for (const url of p.urls) {
    const t = parseTurnUrl(url);
    if (!t || seen.has(t.host + ':' + t.port + t.tls)) continue;
    seen.add(t.host + ':' + t.port + t.tls);
    const r = await checkTurn({ ...t, username: p.username, password: p.credential, open, md5, hmacSha1 });
    if (r.ok) return { ok: true, error: null };
    last = `${t.host}:${t.port} — ${r.error}`;
  }
  return { ok: false, error: last.slice(0, 200) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const body = await req.json().catch(() => ({}));
    const id = new URL(req.url).searchParams.get('id') || body?.id;
    const now = Date.now();
    let list: Provider[];
    if (id) {
      if (!/^[0-9a-f-]{36}$/.test(id)) return reply({ error: 'bad id' }, 400);
      list = await db(`turn_providers?id=eq.${id}&status=neq.disabled&select=id,urls,username,credential,status,last_check`);
      // одну и ту же проверку не чаще раза в 20 секунд
      list = list.filter((p) => !p.last_check || now - Date.parse(p.last_check) > 20_000);
    } else {
      const before = new Date(now - 30 * 60_000).toISOString();
      list = await db(`turn_providers?status=neq.disabled&or=(last_check.is.null,last_check.lt.${before})&select=id,urls,username,credential,status,last_check&limit=50`);
    }
    const results = await Promise.all(list.map(async (p) => {
      const r = await checkOne(p);
      const at = new Date().toISOString();
      await db(`turn_providers?id=eq.${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify(r.ok ? { status: 'active', last_ok: at, last_check: at, last_error: null } : { status: 'failing', last_check: at, last_error: r.error }),
      });
      return { id: p.id, ok: r.ok, error: r.error };
    }));
    if (results.length) await db('rpc/refresh_partners', { method: 'POST', body: '{}' }).catch(() => null);   // уровень обновится сразу
    return reply({ checked: results.length, results });
  } catch (e) {
    console.log('turn-check error', String(e));
    return reply({ error: 'ошибка проверки' }, 500);
  }
});
