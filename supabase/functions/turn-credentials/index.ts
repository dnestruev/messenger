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

  const main = await mainServers(userId);
  const partners = await partnerServers();
  const iceServers = [...main.servers, ...partners];
  if (!iceServers.length) return reply({ error: main.error || 'TURN не настроен на сервере' }, 503);
  return reply({ iceServers, ttlSeconds: 3600, partners: partners.length });
});

/** turn:host:port → ещё и turn:host:port?transport=tcp (если такого нет). Только корректные адреса. */
function withTcp(urls: string[]) {
  const out = [...urls];
  for (const u of urls) {
    const m = /^turn:([^?\s]+)$/i.exec(u);
    if (m && !out.includes(`turn:${m[1]}?transport=tcp`)) out.push(`turn:${m[1]}?transport=tcp`);
  }
  return out;
}

/** Серверы партнёров (проверены функцией turn-check за последние 2 суток): до 3 случайных */
async function partnerServers() {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || '';
  const url = Deno.env.get('SUPABASE_URL');
  if (!key || !url) return [];
  try {
    const since = new Date(Date.now() - 2 * 86400_000).toISOString();
    const r = await fetch(`${url}/rest/v1/turn_providers?status=eq.active&last_ok=gt.${since}&select=urls,username,credential`, {
      headers: { apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }) },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return [];
    const list: { urls: string[]; username: string; credential: string }[] = await r.json();
    // к каждому UDP-адресу добавляем тот же через TCP: VPN и мобильные сети часто режут UDP
    return list.sort(() => Math.random() - 0.5).slice(0, 3).map((p) => ({ urls: withTcp(p.urls), username: p.username, credential: p.credential }));
  } catch { return []; }
}

/** Основной TURN владельца: Cloudflare, постоянные логин/пароль или свой coturn — что настроено в секретах */
async function mainServers(userId: string): Promise<{ servers: { urls: string[]; username?: string; credential?: string }[]; error?: string }> {
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
      if (!r.ok) return { servers: [], error: 'Cloudflare TURN: ' + r.status };
      const data = await r.json();
      const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
      // порт 53 браузеры часто блокируют — такие адреса только тормозят сбор
      const iceServers = list.map((s: { urls: string | string[]; username?: string; credential?: string }) => ({
        ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)),
      })).filter((s: { urls: string[] }) => s.urls.length);
      return { servers: iceServers };
    } catch {
      return { servers: [], error: 'Cloudflare TURN недоступен' };
    }
  }

  const urls = (Deno.env.get('TURN_URLS') || '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => /^turns?:[^\s]+$/i.test(url));

  // Вариант 2: постоянные логин/пароль (ExpressTURN, Metered и т.п.).
  // Секреты: TURN_URLS (через запятую), TURN_USERNAME, TURN_PASSWORD. Выдаём только вошедшим.
  const staticUser = Deno.env.get('TURN_USERNAME');
  const staticPass = Deno.env.get('TURN_PASSWORD');
  if (staticUser && staticPass && urls.length) {
    return { servers: [{ urls: withTcp(urls), username: staticUser, credential: staticPass }] };
  }

  // Вариант 3: свой coturn (use-auth-secret). Секреты: TURN_SHARED_SECRET и TURN_URLS.
  const sharedSecret = Deno.env.get('TURN_SHARED_SECRET');
  if (!sharedSecret || !urls.length) return { servers: [] };

  // TURN REST API (coturn use-auth-secret): имя = unix-expiry:user-id,
  // пароль = base64(HMAC-SHA1(secret, имя)).
  const ttlSeconds = 3600;
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = expires + ':' + userId;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(sharedSecret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return { servers: [{ urls, username, credential }] };
}
