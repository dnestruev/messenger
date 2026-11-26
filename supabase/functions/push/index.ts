// Edge Function «push»: отправляет push-уведомление участникам чата о новом сообщении.
// Текст сообщения сюда не попадает (он зашифрован), поэтому уведомление общее: «Новое сообщение 🔒».
// Зависимостей нет: Web Push (RFC 8291 + VAPID) сделан на встроенном WebCrypto.
// verify_jwt выключен: вызывается только триггером on_message_push → notify_push() из базы.
// v3: не шлём тем, кто заблокировал отправителя (раньше в группах push от заблокированного приходил).

// ===== webpush =====
const enc = new TextEncoder();
const b64u = {
  enc: (buf: ArrayBuffer | Uint8Array) =>
    btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s: string) => {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  },
};
function concat(...arrs: Uint8Array[]) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}
export async function encryptPayload(p256dh: string, auth: string, plaintext: string) {
  const uaPub = b64u.dec(p256dh);
  const authSecret = b64u.dec(auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key,
    concat(enc.encode(plaintext), new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
export async function vapidJwt(endpoint: string, subject: string, publicKey: string, privateKey: string) {
  const pub = b64u.dec(publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), d: privateKey, ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64u.enc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.enc(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + claims));
  return header + '.' + claims + '.' + b64u.enc(sig);
}
type Sub = { endpoint: string; p256dh: string; auth: string };
type Vapid = { subject: string; publicKey: string; privateKey: string };
export async function sendPush(sub: Sub, payload: string, vapid: Vapid) {
  const body = await encryptPayload(sub.p256dh, sub.auth, payload);
  const jwt = await vapidJwt(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey);
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: '3600', Urgency: 'high', Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    },
    body,
  });
}
// ===== /webpush =====

const env = (k: string) => Deno.env.get(k) ?? '';
const SUPABASE_URL = env('SUPABASE_URL');
// Секретный ключ: старый формат (service_role) или новый (sb_secret_…)
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY') ||
  (() => { try { return Object.values(JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}'))[0] as string || ''; } catch { return ''; } })();
const VAPID: Vapid = { subject: env('VAPID_SUBJECT') || 'mailto:admin@example.com', publicKey: env('VAPID_PUBLIC_KEY'), privateKey: env('VAPID_PRIVATE_KEY') };

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      ...(SERVICE_KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${SERVICE_KEY}` }),
      'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** Кому слать: участники чата без отправителя и без тех, кто его заблокировал */
export function recipients(members: { user_id: string }[], blockers: { blocker: string }[]) {
  const skip = new Set(blockers.map((b) => b.blocker));
  return members.map((m) => m.user_id).filter((id) => !skip.has(id));
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => null);
    const id = Number(body?.record?.id);
    if (!id) return new Response('no record', { status: 400 });

    // Берём сообщение из базы (а не из запроса) и помечаем: push отправляется ровно один раз
    const rows = await db(`messages?id=eq.${id}&push_sent=eq.false&select=id,conversation_id,sender_id,created_at`,
      { method: 'PATCH', body: JSON.stringify({ push_sent: true }) });
    const msg = rows[0];
    if (!msg) return new Response('already sent');
    if (Date.now() - Date.parse(msg.created_at) > 10 * 60 * 1000) return new Response('too old');

    const conv = msg.conversation_id;
    const [convRows, senderRows, members, blockers] = await Promise.all([
      db(`conversations?id=eq.${conv}&select=is_group,title`),
      db(`profiles?id=eq.${msg.sender_id}&select=username,display_name`),
      db(`conversation_members?conversation_id=eq.${conv}&user_id=neq.${msg.sender_id}&select=user_id`),
      db(`blocks?blocked=eq.${msg.sender_id}&select=blocker`),
    ]);
    const ids = recipients(members, blockers);
    if (!ids.length) return new Response('nobody');
    const subs: Sub[] = await db(`push_subscriptions?user_id=in.(${ids.join(',')})&select=endpoint,p256dh,auth`);

    const c = convRows[0] || {};
    const s = senderRows[0] || {};
    const name = s.display_name || s.username || 'Кто-то';
    const payload = JSON.stringify({
      title: c.is_group ? (c.title || 'Группа') : name,
      body: c.is_group ? `${name}: новое сообщение 🔒` : 'Новое сообщение 🔒',
      conv,
    });

    let sent = 0;
    await Promise.all(subs.map(async (sub) => {
      try {
        const r = await sendPush(sub, payload, VAPID);
        if (r.status === 404 || r.status === 410) {
          await db(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: 'DELETE' });
        } else if (r.ok) sent++;
        else console.log('push failed', r.status, await r.text());
      } catch (e) { console.log('push error', String(e)); }
    }));
    return new Response(JSON.stringify({ sent }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.log('error', String(e));
    return new Response('error', { status: 500 });
  }
});
