// Проверка TURN-сервера «по-настоящему»: запрос Allocate с долговременной авторизацией
// (RFC 8656 / RFC 5389) по TCP. Успех = сервер принял логин/пароль и выделил адрес для пересылки.
// Работает и в Deno (функция turn-check), и в Node (тесты): сокет и криптографию передают снаружи.

const MAGIC = 0x2112a442;
const T = { ALLOCATE: 0x0003, REFRESH: 0x0004, ALLOCATE_OK: 0x0103, ALLOCATE_ERR: 0x0113 };
const A = { USERNAME: 0x0006, INTEGRITY: 0x0008, ERROR: 0x0009, LIFETIME: 0x000d, REALM: 0x0014, NONCE: 0x0015, TRANSPORT: 0x0019 };
const enc = new TextEncoder();

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function attr(type, value) {
  const pad = (4 - (value.length % 4)) % 4;
  const b = new Uint8Array(4 + value.length + pad);
  const v = new DataView(b.buffer);
  v.setUint16(0, type); v.setUint16(2, value.length);
  b.set(value, 4);
  return b;
}
function message(type, tid, attrs) {
  const body = concat(...attrs);
  const b = new Uint8Array(20 + body.length);
  const v = new DataView(b.buffer);
  v.setUint16(0, type); v.setUint16(2, body.length); v.setUint32(4, MAGIC);
  b.set(tid, 8); b.set(body, 20);
  return b;
}
/** MESSAGE-INTEGRITY: HMAC-SHA1 по сообщению до этого атрибута, в заголовке длина — уже с ним (+24) */
export async function signed(msg, key, hmacSha1) {
  const copy = msg.slice();
  new DataView(copy.buffer).setUint16(2, msg.length - 20 + 24);
  const mac = await hmacSha1(key, copy);
  return concat(copy, attr(A.INTEGRITY, mac));
}
export function parse(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const type = v.getUint16(0), length = v.getUint16(2);
  const attrs = new Map();
  let o = 20;
  while (o + 4 <= 20 + length) {
    const t = v.getUint16(o), l = v.getUint16(o + 2);
    if (!attrs.has(t)) attrs.set(t, b.slice(o + 4, o + 4 + l));
    o += 4 + l + ((4 - (l % 4)) % 4);
  }
  return { type, length, tid: b.slice(8, 20), attrs };
}
const errorCode = (m) => { const e = m.attrs.get(A.ERROR); return e ? (e[2] & 7) * 100 + e[3] : 0; };
const tid = () => crypto.getRandomValues(new Uint8Array(12));

/** Сообщения STUN по TCP идут подряд: собираем ровно одно (20 байт заголовка + длина) */
function reader(sock) {
  let buf = new Uint8Array(0);
  return async function next() {
    for (;;) {
      if (buf.length >= 20) {
        const len = 20 + new DataView(buf.buffer, buf.byteOffset).getUint16(2);
        if (buf.length >= len) { const m = buf.slice(0, len); buf = buf.slice(len); return parse(m); }
      }
      const chunk = await sock.read();
      if (!chunk) throw new Error('сервер закрыл соединение');
      buf = concat(buf, chunk);
    }
  };
}

/** Разобрать turn:host:port?transport=… → { host, port, tls } */
export function parseTurnUrl(url) {
  const m = /^(turns?):([^:?]+)(?::(\d+))?/i.exec(url || '');
  if (!m) return null;
  const tls = m[1].toLowerCase() === 'turns';
  return { host: m[2], port: Number(m[3] || (tls ? 5349 : 3478)), tls };
}

/**
 * Проверить логин/пароль на TURN-сервере.
 * open(host, port, tls) → { write(Uint8Array), read() → Uint8Array|null, close() }
 * md5(Uint8Array) → Uint8Array, hmacSha1(key, data) → Uint8Array (обе могут быть async)
 */
export async function checkTurn({ host, port, tls, username, password, open, md5, hmacSha1, timeoutMs = 7000 }) {
  let sock, timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('сервер не ответил за ' + timeoutMs / 1000 + ' с')), timeoutMs); });
  const work = (async () => {
    sock = await open(host, port, tls);
    const next = reader(sock);
    const transport = attr(A.TRANSPORT, Uint8Array.of(17, 0, 0, 0));   // UDP-пересылка, как у браузеров
    await sock.write(message(T.ALLOCATE, tid(), [transport]));
    let r = await next();
    if (r.type === T.ALLOCATE_OK) return { ok: true, note: 'без пароля' };
    if (r.type !== T.ALLOCATE_ERR || errorCode(r) !== 401) return { ok: false, error: 'неожиданный ответ сервера (' + (errorCode(r) || r.type) + ')' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const realm = r.attrs.get(A.REALM), nonce = r.attrs.get(A.NONCE);
      if (!realm || !nonce) return { ok: false, error: 'сервер не прислал realm/nonce' };
      const key = await md5(enc.encode(username + ':' + new TextDecoder().decode(realm) + ':' + password));
      const auth = [attr(A.USERNAME, enc.encode(username)), attr(A.REALM, realm), attr(A.NONCE, nonce)];
      await sock.write(await signed(message(T.ALLOCATE, tid(), [transport, ...auth]), key, hmacSha1));
      r = await next();
      if (r.type === T.ALLOCATE_OK) {
        // сразу освобождаем выделенный адрес (LIFETIME = 0), чтобы не тратить чужую квоту
        try {
          await sock.write(await signed(message(T.REFRESH, tid(), [attr(A.LIFETIME, Uint8Array.of(0, 0, 0, 0)), ...auth]), key, hmacSha1));
        } catch { /* не важно */ }
        return { ok: true };
      }
      const code = errorCode(r);
      if (code === 438) continue;                       // nonce устарел — повторяем с новым
      if (code === 401) return { ok: false, error: 'неверный логин или пароль' };
      if (code === 486) return { ok: true, note: 'лимит выделений (логин верный)' };
      return { ok: false, error: 'ошибка сервера ' + code };
    }
    return { ok: false, error: 'сервер постоянно меняет nonce' };
  })();
  try { return await Promise.race([work, timeout]); }
  catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 150) }; }
  finally { clearTimeout(timer); try { sock?.close(); } catch {} }
}
