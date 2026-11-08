// Криптография мессенджера. Всё на встроенном WebCrypto, без библиотек.
//
// - Личность: пара ключей ECDH P-256. Секретная часть хранится только на устройстве (IndexedDB),
//   на сервере — её копия, зашифрованная секретным кодом (PBKDF2-SHA256 600 000 + AES-256-GCM).
// - Ключ чата: AES-256-GCM. Для каждого участника он зашифрован отдельно (ECIES: эфемерный ECDH + HKDF).
// - Сообщения и фото шифруются ключом чата; в AAD — чат и отправитель, чтобы их нельзя было подменить.

const te = new TextEncoder();
const td = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' };
const PBKDF2_ITERATIONS = 600000;

export const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

export const b64 = {
  enc(bytes) {
    const u = new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

export function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return b64.dec(s);
}

export const publicJwk = (j) => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y });

export async function fingerprint(jwk) {
  const h = await crypto.subtle.digest('SHA-256', te.encode(jwk.x + '.' + jwk.y));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Хранилище ключей на устройстве ---------- */
function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('messenger-keys', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('keys', mode);
    const req = fn(t.objectStore('keys'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
export const store = {
  get: (k) => tx('readonly', (s) => s.get(k)),
  set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
  del: (k) => tx('readwrite', (s) => s.delete(k)),
};

/* ---------- Личность и резервная копия ---------- */
export async function generateIdentity() {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pub = publicJwk(privateJwk);
  return { privateJwk, publicJwk: pub, fingerprint: await fingerprint(pub) };
}

export const importPrivate = (jwk) => crypto.subtle.importKey('jwk', jwk, ECDH, false, ['deriveBits']);

async function keyFromCode(code, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(code.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealBackup(privateJwk, code) {
  const salt = rnd(16), iv = rnd(12);
  const key = await keyFromCode(code, salt, PBKDF2_ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(privateJwk)));
  return { v: 1, salt: b64.enc(salt), iv: b64.enc(iv), iter: PBKDF2_ITERATIONS, ct: b64.enc(ct) };
}

/** Бросает ошибку, если код неверный. */
export async function openBackup(backup, code) {
  const key = await keyFromCode(code, b64.dec(backup.salt), backup.iter);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(backup.iv) }, key, b64.dec(backup.ct));
  return JSON.parse(td.decode(pt));
}

/* ---------- Ключи чатов ---------- */
export const newChatKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

async function wrappingKey(privateKey, peerJwk, info = 'messenger-wrap-v1') {
  const peer = await crypto.subtle.importKey('jwk', publicJwk(peerJwk), ECDH, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info) },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function wrapChatKey(chatKey, recipientJwk) {
  const eph = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const kek = await wrappingKey(eph.privateKey, recipientJwk);
  const iv = rnd(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, await crypto.subtle.exportKey('raw', chatKey));
  return { v: 1, epk: publicJwk(await crypto.subtle.exportKey('jwk', eph.publicKey)), iv: b64.enc(iv), ct: b64.enc(ct) };
}

export async function unwrapChatKey(wrapped, myPrivateKey) {
  const kek = await wrappingKey(myPrivateKey, wrapped.epk);
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(wrapped.iv) }, kek, b64.dec(wrapped.ct));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

/* ---------- Сообщения и файлы ---------- */
export async function sealJson(key, value, aad) {
  const iv = rnd(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key,
    te.encode(JSON.stringify(value)));
  return { ct: b64.enc(ct), iv: b64.enc(iv) };
}

/** null — нет ключа; { bad: true } — шифр повреждён или подменён. */
export async function openJson(key, ct, iv, aad) {
  if (!key || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(iv), additionalData: te.encode(aad) }, key, b64.dec(ct));
    return JSON.parse(td.decode(pt));
  } catch {
    return { bad: true };
  }
}

export async function sealBytes(key, bytes, aad) {
  const iv = rnd(12);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, bytes);
  return { data, iv: b64.enc(iv) };
}

export const openBytes = (key, data, iv, aad) =>
  crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(iv), additionalData: te.encode(aad) }, key, data);

/* ---------- Код безопасности (одинаковый у обоих собеседников) ---------- */
export async function safetyCode(fpA, fpB) {
  const [a, b] = [fpA, fpB].sort();
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(a + ':' + b)));
  const groups = [];
  for (let i = 0; i < 8; i++) {
    const n = (((h[i * 4] << 24) | (h[i * 4 + 1] << 16) | (h[i * 4 + 2] << 8) | h[i * 4 + 3]) >>> 0) % 100000;
    groups.push(String(n).padStart(5, '0'));
  }
  return groups;
}

/* ---------- Подпись отправителя (ECDSA P-256) ----------
   Секретный ключ подписи хранится на сервере, зашифрованный ключом, который выводится из моего
   ключа ECDH (ECDH с самим собой + HKDF). Поэтому на новом устройстве его не нужно вводить отдельно:
   достаточно секретного кода, который открывает ключ ECDH. */
const SIGN_WRAP_INFO = 'messenger-signing-wrap-v1';

export async function generateSigning() {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { privateJwk, publicJwk: publicJwk(privateJwk) };
}
export const importSigning = (jwk) => crypto.subtle.importKey('jwk', jwk, ECDSA, false, ['sign']);
export const importVerify = (jwk) => crypto.subtle.importKey('jwk', publicJwk(jwk), ECDSA, false, ['verify']);

export async function wrapSigning(signingPrivateJwk, myPrivateKey, myPublicJwk) {
  const key = await wrappingKey(myPrivateKey, myPublicJwk, SIGN_WRAP_INFO);
  const iv = rnd(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(signingPrivateJwk)));
  return { v: 1, iv: b64.enc(iv), ct: b64.enc(ct) };
}
export async function unwrapSigning(wrapped, myPrivateKey, myPublicJwk) {
  const key = await wrappingKey(myPrivateKey, myPublicJwk, SIGN_WRAP_INFO);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(wrapped.iv) }, key, b64.dec(wrapped.ct));
  return importSigning(JSON.parse(td.decode(pt)));
}

export async function signText(signingKey, text) {
  return b64.enc(await crypto.subtle.sign(SIGN_PARAMS, signingKey, te.encode(text)));
}
export async function verifyText(verifyKey, signature, text) {
  try { return await crypto.subtle.verify(SIGN_PARAMS, verifyKey, b64.dec(signature), te.encode(text)); }
  catch { return false; }
}

export async function sha256hex(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Отпечаток ключа чата: по нему проверяют, что выданный ключ — тот самый, а не подсунутый. */
export async function chatKeyCheck(chatKey) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', chatKey));
  const label = te.encode('messenger-keycheck-v1|');
  const buf = new Uint8Array(label.length + raw.length);
  buf.set(label); buf.set(raw, label.length);
  return sha256hex(buf);
}
