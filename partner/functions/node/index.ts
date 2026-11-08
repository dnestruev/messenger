// Функция узла-партнёра «node». Ставится в СВОЁМ проекте Supabase: Edge Functions → Deploy via Editor, имя: node.
// Verify JWT в настройках функции нужно ВЫКЛЮЧИТЬ: токен выдаёт центр мессенджера, а не этот проект.
//
// Что делает:
//   GET  ?op=health  — узел жив
//   POST ?op=put     — сохранить зашифрованный кусок (только участник чата, только один раз, имя = хеш)
//   POST ?op=del     — удалить свой кусок
// Читают данные напрямую из публичной корзины blobs.

import { createClient } from 'jsr:@supabase/supabase-js@2';

// Центр сети (менять не нужно)
const HUB_URL = 'https://jlyuqsqlvhytvsijpejr.supabase.co';
const HUB_KEY = 'sb_publishable_QO1HVSbrQtGuj_XrIkZZLg_YnrcwmAm';

const MAX_OBJECT = 7 * 1024 * 1024;        // 7 МБ на кусок
const MAX_DAY_BYTES = 150 * 1024 * 1024;   // 150 МБ в сутки на человека
const MAX_DAY_OBJECTS = 3000;              // 3000 кусков в сутки на человека
const VERSION = 1;

const env = (k: string) => Deno.env.get(k) ?? '';
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY') ||
  (() => { try { return Object.values(JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}'))[0] as string || ''; } catch { return ''; } })();
const db = createClient(env('SUPABASE_URL'), SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Ключ куска: <id чата>/<sha-256 содержимого в hex>
const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f]{64}$/;

function b64decode(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function sha256hex(bytes: Uint8Array) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Кто это: проверяем токен у центра. */
async function hubUser(token: string): Promise<string | null> {
  const r = await fetch(`${HUB_URL}/auth/v1/user`, { headers: { apikey: HUB_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ?? null;
}
/** Участник ли он этого чата: спрашиваем центр от его имени. */
async function hubIsMember(token: string, conv: string): Promise<boolean> {
  const r = await fetch(`${HUB_URL}/rest/v1/rpc/is_member`, {
    method: 'POST',
    headers: { apikey: HUB_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conv }),
  });
  return r.ok && (await r.json()) === true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const op = new URL(req.url).searchParams.get('op');

  if (op === 'health') return json({ ok: true, node: 'messenger-node', version: VERSION, time: new Date().toISOString() });
  if (req.method !== 'POST' || (op !== 'put' && op !== 'del')) return json({ error: 'unknown op' }, 404);

  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const user = token && await hubUser(token);
    if (!user) return json({ error: 'unauthorized' }, 401);

    const body = await req.json().catch(() => null);
    const key = String(body?.key || '');
    if (!KEY_RE.test(key)) return json({ error: 'bad key' }, 400);
    const conv = key.slice(0, 36);

    if (op === 'del') {
      const { data: obj } = await db.from('node_objects').select('owner').eq('key', key).maybeSingle();
      if (!obj) return json({ ok: true });
      if (obj.owner !== user) return json({ error: 'not yours' }, 403);
      await db.storage.from('blobs').remove([key]);
      await db.from('node_objects').delete().eq('key', key);
      return json({ ok: true });
    }

    // put
    const bytes = b64decode(String(body?.data || ''));
    if (!bytes.length || bytes.length > MAX_OBJECT) return json({ error: 'bad size' }, 413);
    if ((await sha256hex(bytes)) !== key.slice(37)) return json({ error: 'hash mismatch' }, 400);   // имя = хеш: подменить нельзя
    if (!(await hubIsMember(token, conv))) return json({ error: 'not a member' }, 403);

    const { data: exists } = await db.from('node_objects').select('key').eq('key', key).maybeSingle();
    if (exists) return json({ ok: true, existed: true });                                          // уже есть — ничего не перезаписываем

    const { data: allowed } = await db.rpc('node_use', { p_user: user, p_bytes: bytes.length, p_max_bytes: MAX_DAY_BYTES, p_max_objects: MAX_DAY_OBJECTS });
    if (!allowed) return json({ error: 'daily limit' }, 429);

    const up = await db.storage.from('blobs').upload(key, bytes, { contentType: 'application/octet-stream', upsert: false });
    if (up.error && !/exists|duplicate/i.test(up.error.message)) return json({ error: 'storage: ' + up.error.message }, 500);
    await db.from('node_objects').insert({ key, owner: user, bytes: bytes.length });
    return json({ ok: true });
  } catch (e) {
    console.log('node error', String(e));
    return json({ error: 'internal' }, 500);
  }
});
