// Supabase Edge Function: временные TURN-данные для авторизованных пользователей.
// Публикуется с --no-verify-jwt; токен всегда проверяется вручную через Supabase Auth.
// TURN_SHARED_SECRET хранить только в секретах Supabase, НИКОГДА в config.js.
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return reply({ error: 'Метод не поддерживается' }, 405);

  const token = req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return reply({ error: 'Требуется авторизация' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!supabaseUrl || !anonKey) return reply({ error: 'Supabase Auth не настроен' }, 503);

  // /auth/v1/user проверяет подпись, срок действия и отзыв токена на стороне Auth.
  let userId: string;
  try {
    const response = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { apikey: anonKey, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return reply({ error: 'Неавторизованный пользователь' }, 401);
    const user = await response.json();
    if (typeof user.id !== 'string' || !user.id) return reply({ error: 'Неавторизованный пользователь' }, 401);
    userId = user.id;
  } catch {
    return reply({ error: 'Сервер авторизации недоступен' }, 503);
  }

  // Вариант 1: Cloudflare Realtime TURN (бесплатно до 1000 ГБ в месяц).
  // Секреты: CF_TURN_KEY_ID и CF_TURN_API_TOKEN (Cloudflare → Realtime → TURN Server → Create).
  const cfKey = Deno.env.get('CF_TURN_KEY_ID');
  const cfToken = Deno.env.get('CF_TURN_API_TOKEN');
  if (cfKey && cfToken) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cfKey)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 3600, customIdentifier: userId.slice(0, 36) }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return reply({ error: 'Cloudflare TURN: ' + r.status }, 502);
      const data = await r.json();
      const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
      // порт 53 браузеры часто блокируют — такие адреса только тормозят сбор
      const iceServers = list.map((s: { urls: string | string[]; username?: string; credential?: string }) => ({
        ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)),
      })).filter((s: { urls: string[] }) => s.urls.length);
      return reply({ iceServers, ttlSeconds: 3600 });
    } catch {
      return reply({ error: 'Cloudflare TURN недоступен' }, 502);
    }
  }

  // Вариант 2: свой coturn (use-auth-secret). Секреты: TURN_SHARED_SECRET и TURN_URLS.
  const sharedSecret = Deno.env.get('TURN_SHARED_SECRET');
  const urls = (Deno.env.get('TURN_URLS') || '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => /^turns?:[^\s]+$/i.test(url));
  if (!sharedSecret || !urls.length) return reply({ error: 'TURN не настроен на сервере' }, 503);

  // TURN REST API (coturn use-auth-secret): имя = unix-expiry:user-id,
  // пароль = base64(HMAC-SHA1(secret, имя)).
  const ttlSeconds = 3600;
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = expires + ':' + userId;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(sharedSecret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return reply({
    iceServers: [{ urls, username, credential }],
    ttlSeconds,
  });
});
