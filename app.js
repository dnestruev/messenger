import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from './config.js';

const $ = (id) => document.getElementById(id);
const BUCKET = 'chat-images';
const HUES = [260, 320, 350, 20, 45, 150, 190, 220];

if (SUPABASE_URL.includes('ВАШ') || SUPABASE_KEY.includes('ВАШ')) {
  $('configWarn').classList.remove('hidden');
  throw new Error('config.js не заполнен');
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

let me = null;                      // { id, email }
const people = new Map();           // id -> { username, display_name, avatar_hue }
const convs = new Map();            // id -> чат из my_chats()
const history = new Map();          // id чата -> [сообщения]
const images = new Map();           // путь -> blob: ссылка на расшифрованное фото
let activeId = null;
let channel = null;

/* ---------- Приложение (PWA) ---------- */
let swReg = null;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then((r) => { swReg = r; }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.open && me) openChat(e.data.open); });
}
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

/* ---------- Настройки на этом устройстве ---------- */
const prefs = { theme: 'light', sound: true, notify: false };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('prefs') || '{}')); } catch {}
function savePrefs() { try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch {} }

function applyTheme() {
  document.body.classList.toggle('dark', prefs.theme === 'dark');
  $('themeBtn').textContent = prefs.theme === 'dark' ? '☀️' : '🌙';
}
applyTheme();
$('themeBtn').onclick = () => { prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark'; savePrefs(); applyTheme(); };

/* =====================================================================
   ШИФРОВАНИЕ
   - у каждого пользователя пара ключей ECDH P-256; секретный ключ живёт только на устройстве,
     а на сервере лежит его копия, зашифрованная секретным кодом (PBKDF2 600 000 + AES-GCM);
   - у каждого чата свой ключ AES-256-GCM; он зашифрован отдельно для каждого участника (ECIES);
   - сообщения и фото шифруются ключом чата, сервер видит только шифр.
   ===================================================================== */
const te = new TextEncoder(), td = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const B64 = {
  enc: (b) => { const u = new Uint8Array(b); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); },
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
const b64uToBytes = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return B64.dec(s); };
const pubOnly = (j) => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y });

let myPriv = null, myFp = null;
const convKeys = new Map();         // id чата -> ключ AES-GCM
const pubKeys = new Map();          // id пользователя -> { jwk, fp }
let known = {};                     // id пользователя -> отпечаток, которому мы доверяем (на этом устройстве)

async function fingerprint(jwk) {
  const h = await crypto.subtle.digest('SHA-256', te.encode(jwk.x + '.' + jwk.y));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Хранилище ключей в браузере (IndexedDB)
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('messenger-keys', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbOp(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('keys', mode);
    const q = fn(t.objectStore('keys'));
    t.oncomplete = () => res(q?.result);
    t.onerror = () => rej(t.error);
  });
}
const idbGet = (k) => idbOp('readonly', (s) => s.get(k));
const idbSet = (k, v) => idbOp('readwrite', (s) => s.put(v, k));
const idbDel = (k) => idbOp('readwrite', (s) => s.delete(k));

async function codeKey(code, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(code.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function makeBackup(privJwk, code) {
  const salt = rnd(16), iv = rnd(12), iter = 600000;
  const k = await codeKey(code, salt, iter);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, te.encode(JSON.stringify(privJwk)));
  return { v: 1, salt: B64.enc(salt), iv: B64.enc(iv), iter, ct: B64.enc(ct) };
}
async function openBackup(b, code) {
  const k = await codeKey(code, B64.dec(b.salt), b.iter);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: B64.dec(b.iv) }, k, B64.dec(b.ct));
  return JSON.parse(td.decode(pt));
}
const importPriv = (jwk) => crypto.subtle.importKey('jwk', jwk, ECDH, false, ['deriveBits']);

async function kekFrom(privKey, pubJwk) {
  const pub = await crypto.subtle.importKey('jwk', pubOnly(pubJwk), ECDH, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, privKey, 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('messenger-wrap-v1') },
    hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function wrapFor(convKey, recipientJwk) {
  const eph = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const kek = await kekFrom(eph.privateKey, recipientJwk);
  const iv = rnd(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, await crypto.subtle.exportKey('raw', convKey));
  return { v: 1, epk: pubOnly(await crypto.subtle.exportKey('jwk', eph.publicKey)), iv: B64.enc(iv), ct: B64.enc(ct) };
}
async function unwrap(w) {
  const kek = await kekFrom(myPriv, w.epk);
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: B64.dec(w.iv) }, kek, B64.dec(w.ct));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}
const aad = (convId, senderId) => te.encode(convId + '|' + senderId);
async function encryptMsg(convId, payload) {
  const iv = rnd(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(convId, me.id) },
    convKeys.get(convId), te.encode(JSON.stringify(payload)));
  return { ct: B64.enc(ct), iv: B64.enc(iv) };
}
async function decryptMsg(convId, senderId, ct, iv) {
  const key = convKeys.get(convId);
  if (!key || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: B64.dec(iv), additionalData: aad(convId, senderId) }, key, B64.dec(ct));
    return JSON.parse(td.decode(pt));
  } catch { return { bad: true }; }
}

async function loadKnown() { known = (await idbGet('known:' + me.id).catch(() => null)) || {}; }
async function saveKnown() { await idbSet('known:' + me.id, known).catch(() => {}); }

async function loadPubKeys(ids, force = false) {
  const need = [...new Set(ids)].filter((id) => force || !pubKeys.has(id));
  if (!need.length) return;
  const { data } = await sb.from('user_keys').select('user_id, public_key, fingerprint').in('user_id', need);
  for (const r of data || []) pubKeys.set(r.user_id, { jwk: r.public_key, fp: r.fingerprint });
}

/* Ключи пользователя: создать, восстановить кодом или взять с устройства */
async function ensureMyKeys() {
  const { data: row, error } = await sb.from('user_keys').select('public_key, fingerprint').eq('user_id', me.id).maybeSingle();
  if (error) throw error;
  const local = await idbGet('me:' + me.id).catch(() => null);
  if (row && local && local.fp === row.fingerprint) {
    myPriv = local.priv; myFp = local.fp;
    pubKeys.set(me.id, { jwk: row.public_key, fp: myFp });
  } else await keyDialog(row);
  await loadKnown();
}

async function createKeys(code) {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pubJwk = pubOnly(privJwk);
  const fp = await fingerprint(pubJwk);
  const backup = await makeBackup(privJwk, code);
  let r = await sb.from('key_backups').upsert({ user_id: me.id, backup, updated_at: new Date().toISOString() });
  if (r.error) throw r.error;
  r = await sb.from('user_keys').upsert({ user_id: me.id, public_key: pubJwk, fingerprint: fp, updated_at: new Date().toISOString() });
  if (r.error) throw r.error;
  await useKey(privJwk, fp, pubJwk);
}
async function useKey(privJwk, fp, pubJwk) {
  myPriv = await importPriv(privJwk);
  myFp = fp;
  pubKeys.set(me.id, { jwk: pubJwk, fp });
  await idbSet('me:' + me.id, { priv: myPriv, fp });
}

function keyDialog(row) {
  return new Promise((resolve) => {
    const restore = !!row;
    openModal(restore ? `
      <div class="modal-head"><h3>🔐 Введите секретный код</h3></div>
      <p class="small">Вы вошли на новом устройстве. Код нужен, чтобы расшифровать вашу переписку.</p>
      <input id="kCode" type="password" placeholder="Секретный код" autocomplete="off">
      <button class="primary grad" id="kGo">Расшифровать</button>
      <div class="msg" id="kMsg"></div>
      <button class="secondary" id="kForgot">Забыл код</button>` : `
      <div class="modal-head"><h3>🔐 Включаем шифрование</h3></div>
      <p class="small">Сообщения и фото будут видны только участникам чата: ни сервер, ни кто-либо ещё их не прочитает.
        Придумайте <b>секретный код</b> от 8 символов, лучше фразу из нескольких слов. Он нужен для входа с других устройств.
        <b>Забудете код — старые сообщения на новом устройстве не откроются,</b> пока друзья не подтвердят ваш новый ключ.</p>
      <input id="kCode" type="password" placeholder="Секретный код (от 8 символов)" autocomplete="new-password">
      <input id="kCode2" type="password" placeholder="Повторите код" autocomplete="new-password">
      <button class="primary grad" id="kGo">Включить шифрование</button>
      <div class="msg" id="kMsg"></div>`, { locked: true });
    $('kCode').focus();
    const busy = (on, text) => { $('kGo').disabled = on; if (text) say('kMsg', text, 'ok'); };
    $('kGo').onclick = async () => {
      const code = $('kCode').value;
      try {
        if (restore) {
          busy(true, 'Проверяю код…');
          const { data: b, error } = await sb.from('key_backups').select('backup').eq('user_id', me.id).maybeSingle();
          if (error) throw error;
          if (!b) throw new Error('Резервная копия не найдена. Нажмите «Забыл код».');
          let privJwk;
          try { privJwk = await openBackup(b.backup, code); } catch { throw new Error('Неверный код'); }
          if (privJwk.x !== row.public_key.x) throw new Error('Копия ключа устарела. Нажмите «Забыл код».');
          await useKey(privJwk, row.fingerprint, row.public_key);
        } else {
          if (code.length < 8) throw new Error('Код должен быть от 8 символов');
          if (code !== $('kCode2').value) throw new Error('Коды не совпадают');
          busy(true, 'Создаю ключи…');
          await createKeys(code);
        }
        closeModal(); resolve();
      } catch (err) { busy(false); say('kMsg', humanError(err)); }
    };
    $('kCode').onkeydown = (e) => { if (e.key === 'Enter' && restore) $('kGo').click(); };
    if (restore) $('kForgot').onclick = () => {
      if (!confirm('Создать новые ключи? Старые сообщения станут видны снова, только когда друзья откроют чат и подтвердят ваш новый ключ.')) return;
      closeModal();
      keyDialog(null).then(resolve);
    };
  });
}

/* Ключи чатов */
async function loadConvKeys() {
  const { data } = await sb.from('conversation_keys').select('conversation_id, for_fingerprint, wrapped').eq('user_id', me.id);
  const got = [];
  for (const r of data || []) {
    if (r.for_fingerprint !== myFp || convKeys.has(r.conversation_id)) continue;
    try { convKeys.set(r.conversation_id, await unwrap(r.wrapped)); got.push(r.conversation_id); } catch {}
  }
  return got;
}

async function ensureConvKey(convId) {
  if (convKeys.has(convId)) return true;
  const { data: r } = await sb.from('conversation_keys').select('for_fingerprint, wrapped')
    .eq('conversation_id', convId).eq('user_id', me.id).maybeSingle();
  if (r) {
    if (r.for_fingerprint !== myFp) return false;   // зашифрован для старого ключа: ждём друзей
    try { convKeys.set(convId, await unwrap(r.wrapped)); return true; } catch { return false; }
  }
  const { data: won, error } = await sb.rpc('claim_conversation_key', { conv: convId });
  if (error || !won) return false;
  convKeys.set(convId, await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']));
  await shareConvKey(convId);
  return true;
}

// Делимся ключом чата с участниками, у которых его ещё нет
async function shareConvKey(convId) {
  const key = convKeys.get(convId);
  const c = convs.get(convId);
  if (!key || !c) return;
  const members = c.member_ids || [];
  await loadPubKeys(members);
  const { data: rows } = await sb.from('conversation_keys').select('user_id, for_fingerprint').eq('conversation_id', convId);
  const have = new Map((rows || []).map((r) => [r.user_id, r.for_fingerprint]));
  const out = [], warn = [];
  let knownChanged = false;
  for (const uid of members) {
    const pk = pubKeys.get(uid);
    if (!pk?.jwk) continue;                          // человек ещё не включил шифрование
    if (uid !== me.id) {
      if (!known[uid]) { known[uid] = pk.fp; knownChanged = true; }
      if (known[uid] !== pk.fp) { warn.push(uid); continue; }   // ключ сменился — нужно подтверждение
    }
    if (have.get(uid) === pk.fp) continue;
    out.push({ conversation_id: convId, user_id: uid, for_fingerprint: pk.fp, wrapped: await wrapFor(key, pk.jwk) });
  }
  if (knownChanged) await saveKnown();
  if (out.length) await sb.from('conversation_keys').upsert(out, { onConflict: 'conversation_id,user_id' });
  const before = (c.keyWarn || []).join();
  c.keyWarn = warn;
  if (convId === activeId && before !== warn.join()) renderMessages();
}

async function shareAll() {
  for (const id of convKeys.keys()) { if (convs.has(id)) await shareConvKey(id).catch(() => {}); }
}

async function decryptInto(m) {
  if (m.p && !m.p.bad) return m;
  m.p = await decryptMsg(m.conversation_id, m.sender_id, m.ct, m.iv);
  return m;
}

async function safetyCode(a, b) {
  const [x, y] = [a, b].sort();
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(x + ':' + y)));
  const groups = [];
  for (let i = 0; i < 8; i++) {
    const n = (((h[i * 4] << 24) | (h[i * 4 + 1] << 16) | (h[i * 4 + 2] << 8) | h[i * 4 + 3]) >>> 0) % 100000;
    groups.push(String(n).padStart(5, '0'));
  }
  return groups;
}

/* ---------- Вход и регистрация ---------- */
let mode = 'login';
function setMode(m) {
  mode = m;
  $('tabLogin').classList.toggle('on', m === 'login');
  $('tabSignup').classList.toggle('on', m === 'signup');
  $('username').classList.toggle('hidden', m === 'login');
  $('authBtn').textContent = m === 'login' ? 'Войти' : 'Создать аккаунт ✨';
  $('authSub').textContent = m === 'login' ? 'Рады видеть снова' : 'Пара секунд, и вы с нами';
  $('password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  say('authMsg', '');
}
$('tabLogin').onclick = () => setMode('login');
$('tabSignup').onclick = () => setMode('signup');

function say(id, text, kind = 'err') {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'msg ' + (text ? kind : '');
}

$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  const password = $('password').value;
  $('authBtn').disabled = true;
  try {
    if (mode === 'login') {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } else {
      const username = $('username').value.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,24}$/.test(username)) throw new Error('Ник: 3–24 символа, латиница, цифры или _');
      const { data: free, error: e1 } = await sb.rpc('username_available', { name: username });
      if (e1) throw e1;
      if (!free) throw new Error('Этот ник уже занят');
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: { data: { username }, emailRedirectTo: location.origin + location.pathname }
      });
      if (error) throw error;
      if (!data.session) say('authMsg', 'Готово! Подтвердите email по ссылке из письма, потом войдите.', 'ok');
    }
  } catch (err) {
    say('authMsg', humanError(err));
  } finally {
    $('authBtn').disabled = false;
  }
};

function humanError(err) {
  const m = (err && err.message) || String(err);
  if (/Invalid login credentials/i.test(m)) return 'Неверный email или пароль';
  if (/Email not confirmed/i.test(m)) return 'Сначала подтвердите email по ссылке из письма';
  if (/already registered/i.test(m)) return 'Этот email уже зарегистрирован';
  if (/rate limit/i.test(m)) return 'Слишком много попыток, подождите немного';
  if (/Failed to fetch/i.test(m)) return 'Нет связи с сервером. Проверьте интернет';
  if (/user_keys|key_backups|conversation_keys|messages_e2ee|last_ct/i.test(m) && /not find|does not exist|schema cache/i.test(m))
    return 'База не обновлена: запустите update-2.sql в Supabase';
  if (/my_chats|get_or_create_dm|conversation/i.test(m) && /not find|does not exist/i.test(m))
    return 'База не обновлена: запустите update-1.sql и update-2.sql в Supabase';
  if (/should be different/i.test(m)) return 'Новый пароль совпадает со старым';
  if (/Password should be/i.test(m)) return 'Пароль слишком короткий (нужно от 6 символов)';
  return m;
}

sb.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => session ? startApp(session.user) : stopApp(), 0);
});

/* ---------- Запуск ---------- */
async function startApp(user) {
  if (me && me.id === user.id) return;
  me = { id: user.id, email: user.email };
  await loadPeople([me.id]);
  if (!people.has(me.id)) people.set(me.id, { username: user.user_metadata?.username || 'me' });

  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  renderMe();
  try {
    await ensureMyKeys();
  } catch (err) {
    $('chatList').innerHTML = `<div class="empty">⚠️ ${esc(humanError(err))}</div>`;
    return;
  }
  await loadConvKeys();
  await loadChats();
  subscribe();
  shareAll();
  if (prefs.notify) setupPush(true).catch(() => {});
  const m = location.hash.match(/c=([0-9a-f-]{36})/);
  if (m) { window.history.replaceState(null, '', location.pathname); openChat(m[1]); }
}

function stopApp() {
  me = null; activeId = null; myPriv = null; myFp = null;
  convs.clear(); history.clear(); people.clear(); convKeys.clear(); pubKeys.clear();
  for (const u of images.values()) URL.revokeObjectURL(u);
  images.clear();
  if (channel) { sb.removeChannel(channel); channel = null; }
  closeModal();
  $('app').classList.add('hidden');
  $('auth').classList.remove('hidden');
  document.body.classList.remove('in-chat');
  showPlaceholder();
  document.title = 'Мессенджер';
}

function renderMe() {
  const p = people.get(me.id);
  $('meName').textContent = p.display_name || '@' + p.username;
  $('meAvatar').innerHTML = avatarOf(me.id, 'sm');
}

/* ---------- Люди ---------- */
async function loadPeople(ids) {
  const missing = [...new Set(ids)].filter((id) => id && !people.has(id));
  if (!missing.length) return;
  const { data } = await sb.from('profiles').select('id, username, display_name, avatar_hue').in('id', missing);
  for (const p of data || []) people.set(p.id, p);
}
const nameOf = (id) => { const p = people.get(id); return p ? (p.display_name || p.username) : '…'; };
const nickOf = (id) => '@' + (people.get(id)?.username || '');

function hueFor(text) { let h = 0; for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
function avatarHTML(label, hue, size = '', extra = '') {
  const bg = `linear-gradient(135deg, hsl(${hue} 80% 66%), hsl(${(hue + 40) % 360} 75% 58%))`;
  return `<div class="avatar ${size}" style="background:${bg}">${esc((label[0] || '?').toUpperCase())}${extra}</div>`;
}
function avatarOf(userId, size = '') {
  const p = people.get(userId) || {};
  const label = p.display_name || p.username || '?';
  return avatarHTML(label, p.avatar_hue ?? hueFor(p.username || label), size);
}

/* ---------- Чаты ---------- */
const otherOf = (c) => (c.member_ids || []).find((id) => id !== me.id);
const titleOf = (c) => c.is_group ? (c.title || 'Группа') : nameOf(otherOf(c));
function convAvatar(c, size = '') {
  if (!c.is_group) return avatarOf(otherOf(c), size);
  return avatarHTML(c.title || 'Г', hueFor(c.title || 'Г'), size, '<span class="grp">👥</span>');
}
const ts = (x) => x ? Date.parse(x) : 0;
const isUnread = (c) => c.last_sender && c.last_sender !== me.id && ts(c.last_read_at) < ts(c.last_message_at);

async function loadChats() {
  const { data, error } = await sb.rpc('my_chats');
  if (error) { $('chatList').innerHTML = `<div class="empty">⚠️ ${esc(humanError(error))}</div>`; return; }
  const old = new Map(convs);
  convs.clear();
  for (const c of data) {
    c.keyWarn = old.get(c.id)?.keyWarn;
    c.last_p = await decryptMsg(c.id, c.last_sender, c.last_ct, c.last_iv);
    convs.set(c.id, c);
  }
  await loadPeople(data.flatMap((c) => c.member_ids || []));
  renderChats();
}

function renderChats() {
  const list = $('chatList');
  const items = [...convs.values()].sort((a, b) => ts(b.last_message_at) - ts(a.last_message_at));
  const unread = items.filter(isUnread).length;
  document.title = unread ? `(${unread}) Мессенджер` : 'Мессенджер';
  if (navigator.setAppBadge) (unread ? navigator.setAppBadge(unread) : navigator.clearAppBadge()).catch?.(() => {});
  if (!items.length) {
    list.innerHTML = '<div class="empty"><span class="big">🌱</span>Чатов пока нет.<br>Впишите ник друга в поиск или создайте группу 👥</div>';
    return;
  }
  list.innerHTML = '';
  for (const c of items) {
    const el = document.createElement('div');
    const un = isUnread(c) && c.id !== activeId;
    el.className = 'chat-item' + (c.id === activeId ? ' active' : '') + (un ? ' unread' : '');
    el.innerHTML = `${convAvatar(c)}
      <div class="chat-meta">
        <div class="chat-name"><span></span><small></small></div>
        <div class="chat-last"></div>
      </div>${un ? '<span class="dot"></span>' : ''}`;
    el.querySelector('.chat-name span').textContent = titleOf(c);
    el.querySelector('.chat-name small').textContent = c.last_sender ? timeShort(c.last_message_at) : '';
    el.querySelector('.chat-last').textContent = preview(c);
    el.onclick = () => openChat(c.id);
    list.appendChild(el);
  }
}

function bodyText(p) {
  if (!p) return '🔒 Зашифровано';
  if (p.bad) return '⚠️ Не удалось расшифровать';
  return p.img ? '📷 ' + (p.t || 'Фото') : p.t;
}
function preview(c) {
  if (!c.last_sender) return c.is_group ? 'Группа создана 🎉' : 'Новый чат 🔒';
  const who = c.last_sender === me.id ? 'Вы: ' : (c.is_group ? nameOf(c.last_sender) + ': ' : '');
  return who + bodyText(c.last_p);
}

/* ---------- Поиск по нику → личный чат ---------- */
$('findForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('findInput').value.trim().toLowerCase().replace(/^@/, '');
  if (!q) return;
  if (q === people.get(me.id).username) return say('findMsg', 'Это же вы 😄');
  const { data, error } = await sb.from('profiles').select('id, username, display_name, avatar_hue').eq('username', q).maybeSingle();
  if (error) return say('findMsg', humanError(error));
  if (!data) return say('findMsg', 'Не нашли @' + q + ' 🤔 Проверьте ник');
  people.set(data.id, data);
  const { data: convId, error: e2 } = await sb.rpc('get_or_create_dm', { other: data.id });
  if (e2) return say('findMsg', humanError(e2));
  say('findMsg', '');
  $('findInput').value = '';
  await loadChats();
  await openChat(convId);
};

/* ---------- Открытый чат ---------- */
function showPlaceholder() {
  $('placeholder').classList.remove('hidden');
  $('messages').classList.add('hidden');
  $('composer').classList.add('hidden');
  $('uploading').classList.add('hidden');
  $('chatTitle').textContent = '';
  $('chatStatus').textContent = '';
  $('chatAvatar').innerHTML = '';
}

function renderHeader() {
  const c = convs.get(activeId);
  if (!c) return;
  $('chatTitle').textContent = titleOf(c);
  $('chatAvatar').innerHTML = convAvatar(c, 'sm');
  const n = (c.member_ids || []).length;
  $('chatStatus').textContent = '🔒 ' + (c.is_group ? `${n} ${plural(n, 'участник', 'участника', 'участников')} · нажмите для настроек`
                                                    : nickOf(otherOf(c)) + ' · код безопасности');
}

async function openChat(id) {
  if (!convs.has(id)) await loadChats();
  if (!convs.has(id)) return;
  activeId = id;
  document.body.classList.add('in-chat');
  $('placeholder').classList.add('hidden');
  $('messages').classList.remove('hidden');
  $('composer').classList.remove('hidden');
  renderHeader();
  markRead(id);
  renderChats();

  if (!history.has(id)) {
    $('messages').innerHTML = '<div class="day">Загрузка…</div>';
    const { data, error } = await sb.from('messages').select('id, conversation_id, sender_id, ct, iv, created_at')
      .eq('conversation_id', id).order('created_at', { ascending: false }).limit(200);
    if (error) { $('messages').innerHTML = `<div class="day">⚠️ ${esc(error.message)}</div>`; return; }
    const merged = new Map([...(history.get(id) || []), ...data.reverse()].map((m) => [m.id, m]));
    history.set(id, [...merged.values()].sort((a, b) => ts(a.created_at) - ts(b.created_at)));
    await loadPeople(history.get(id).map((m) => m.sender_id));
  }
  await ensureConvKey(id).catch(() => false);
  await Promise.all((history.get(id) || []).map(decryptInto));
  if (activeId === id) { renderMessages(); if (matchMedia('(min-width: 721px)').matches) $('text').focus(); }
  shareConvKey(id).catch(() => {});
}

$('backBtn').onclick = () => {
  document.body.classList.remove('in-chat');
  activeId = null;
  showPlaceholder();
  renderChats();
};
$('chatInfo').onclick = () => { if (activeId) openChatInfo(activeId); };

async function markRead(id) {
  const c = convs.get(id);
  if (!c || document.hidden) return;
  c.last_read_at = new Date(Math.max(Date.now(), ts(c.last_message_at))).toISOString();
  await sb.from('conversation_members').update({ last_read_at: c.last_read_at })
    .eq('conversation_id', id).eq('user_id', me.id);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activeId) { markRead(activeId); renderChats(); }
});

function renderMessages() {
  const box = $('messages');
  const c = convs.get(activeId);
  const list = history.get(activeId) || [];
  box.innerHTML = '';
  const note = document.createElement('div');
  note.className = 'lock-note';
  note.textContent = convKeys.has(activeId)
    ? '🔒 Сообщения и фото защищены сквозным шифрованием. Прочитать их могут только участники чата.'
    : '🔒 Ждём ключ шифрования: он придёт, когда собеседник откроет приложение.';
  box.appendChild(note);
  for (const uid of c?.keyWarn || []) {
    const w = document.createElement('div');
    w.className = 'warn';
    w.innerHTML = `<div>⚠️ У <b></b> сменился ключ безопасности: новое устройство без кода или сброс ключей. Если это не так, кто-то может пытаться читать переписку. Сверьте код безопасности с другом, прежде чем доверять.</div><button>Доверять новому ключу</button>`;
    w.querySelector('b').textContent = nameOf(uid);
    w.querySelector('button').onclick = async () => {
      known[uid] = pubKeys.get(uid)?.fp; await saveKnown();
      await shareConvKey(activeId); renderMessages();
    };
    box.appendChild(w);
  }
  if (!list.length) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.innerHTML = `<span class="big">👋</span>${c?.is_group ? 'Группа готова! Напишите первое сообщение.' : 'Начните разговор, скажите «привет»!'}`;
    box.appendChild(h);
  }
  let lastDay = '', prevSender = null;
  for (const m of list) {
    const day = new Date(m.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    if (day !== lastDay) {
      const d = document.createElement('div');
      d.className = 'day'; d.textContent = day; box.appendChild(d);
      lastDay = day; prevSender = null;
    }
    box.appendChild(bubble(m, c?.is_group && m.sender_id !== me.id && m.sender_id !== prevSender));
    prevSender = m.sender_id;
  }
  resolveImages(box);
  box.scrollTop = box.scrollHeight;
}

function bubble(m, showName) {
  const el = document.createElement('div');
  const p = m.p;
  el.className = 'bubble' + (m.sender_id === me.id ? ' mine' : '') + (p?.img ? ' photo' : '') + (!p || p.bad ? ' locked' : '');
  if (showName) {
    const f = document.createElement('div');
    f.className = 'from';
    const pr = people.get(m.sender_id);
    f.style.color = `hsl(${pr?.avatar_hue ?? hueFor(pr?.username || '')} 65% 50%)`;
    f.textContent = nameOf(m.sender_id);
    el.appendChild(f);
  }
  if (p?.img) {
    const img = document.createElement('img');
    img.dataset.path = p.img.path;
    img.dataset.iv = p.img.iv;
    img.dataset.mime = p.img.mime || 'image/jpeg';
    img.dataset.conv = m.conversation_id;
    if (p.img.w && p.img.h) img.style.aspectRatio = `${p.img.w} / ${p.img.h}`;
    img.alt = 'Фото';
    img.onclick = () => img.src && openLightbox(img.src);
    el.appendChild(img);
  }
  const text = !p ? '🔒 Сообщение ещё не расшифровано' : p.bad ? '⚠️ Не удалось расшифровать' : p.t;
  if (text) {
    const t = document.createElement('div');
    if (p?.img) t.className = 'cap';
    t.textContent = text;
    el.appendChild(t);
  }
  const time = document.createElement('time');
  time.textContent = new Date(m.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  el.appendChild(time);
  return el;
}

async function resolveImages(root) {
  for (const img of root.querySelectorAll('img[data-path]')) {
    const path = img.dataset.path;
    if (images.has(path)) { img.src = images.get(path); continue; }
    (async () => {
      try {
        const key = convKeys.get(img.dataset.conv);
        if (!key) return;
        const { data, error } = await sb.storage.from(BUCKET).download(path);
        if (error) throw error;
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: B64.dec(img.dataset.iv), additionalData: te.encode(path) },
          key, await data.arrayBuffer());
        const url = URL.createObjectURL(new Blob([pt], { type: img.dataset.mime }));
        images.set(path, url);
        img.src = url;
        const b = $('messages');
        if (b.scrollHeight - b.scrollTop - b.clientHeight < 500) b.scrollTop = b.scrollHeight;
      } catch { img.alt = '⚠️ Фото не открылось'; }
    })();
  }
}

function openLightbox(src) {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  const im = document.createElement('img');
  im.src = src;
  lb.appendChild(im);
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
}

/* ---------- Отправка ---------- */
async function readyToSend(convId) {
  if (await ensureConvKey(convId).catch(() => false)) return true;
  alertInline('🔒 Ключ шифрования ещё не получен. Он придёт, когда собеседник откроет приложение.');
  return false;
}

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('text');
  const content = input.value.trim();
  if (!content || !activeId) return;
  const convId = activeId;
  if (!(await readyToSend(convId))) return;
  input.value = '';
  try {
    const { ct, iv } = await encryptMsg(convId, { t: content });
    const { data, error } = await sb.from('messages')
      .insert({ conversation_id: convId, sender_id: me.id, ct, iv }).select('id, conversation_id, sender_id, ct, iv, created_at').single();
    if (error) throw error;
    data.p = { t: content };
    addMessage(data);
  } catch (err) { input.value = content; alertInline('Не отправилось: ' + humanError(err)); }
};

$('fileInput').onchange = () => {
  const f = $('fileInput').files[0];
  $('fileInput').value = '';
  if (f) sendImage(f);
};
$('text').addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); sendImage(f); }
});

async function sendImage(file) {
  if (!activeId) return;
  if (!file.type.startsWith('image/')) return alertInline('Можно отправлять только картинки');
  const convId = activeId;
  if (!(await readyToSend(convId))) return;
  const caption = $('text').value.trim();
  $('uploading').classList.remove('hidden');
  try {
    const { blob, type, w, h } = await shrink(file);
    if (blob.size > 6 * 1024 * 1024) throw new Error('Картинка слишком большая');
    const path = `${convId}/${crypto.randomUUID()}.bin`;
    const fiv = rnd(12);
    const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fiv, additionalData: te.encode(path) },
      convKeys.get(convId), await blob.arrayBuffer());
    const { error: upErr } = await sb.storage.from(BUCKET).upload(path, new Blob([enc], { type: 'application/octet-stream' }),
      { contentType: 'application/octet-stream' });
    if (upErr) throw upErr;
    images.set(path, URL.createObjectURL(blob));
    const payload = { t: caption, img: { path, iv: B64.enc(fiv), mime: type, w, h } };
    const { ct, iv } = await encryptMsg(convId, payload);
    const { data, error } = await sb.from('messages')
      .insert({ conversation_id: convId, sender_id: me.id, ct, iv }).select('id, conversation_id, sender_id, ct, iv, created_at').single();
    if (error) throw error;
    if (caption) $('text').value = '';
    data.p = payload;
    addMessage(data);
  } catch (err) {
    alertInline('Фото не отправилось: ' + humanError(err));
  } finally {
    $('uploading').classList.add('hidden');
  }
}

// Уменьшаем фото до 1600 px, чтобы экономить бесплатный 1 ГБ
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  if (file.type === 'image/gif' && file.size < 4 * 1024 * 1024) return { blob: file, type: 'image/gif', w: bmp.width, h: bmp.height };
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
  return { blob, type: 'image/jpeg', w: canvas.width, h: canvas.height };
}

function alertInline(text) {
  const box = $('messages');
  const d = document.createElement('div');
  d.className = 'day'; d.style.color = 'var(--err)'; d.textContent = text;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}

/* ---------- Реальное время ---------- */
function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('inbox-' + me.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
        (p) => addMessage(p.new, true))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversation_members', filter: `user_id=eq.${me.id}` },
        async () => { await loadChats(); shareAll(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_keys', filter: `user_id=eq.${me.id}` },
        () => onKeysArrived())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_keys' },
        async (p) => {
          const uid = p.new?.user_id;
          if (!uid || uid === me.id) return;
          await loadPubKeys([uid], true);
          for (const c of convs.values()) if ((c.member_ids || []).includes(uid)) shareConvKey(c.id).catch(() => {});
        })
    .subscribe();
}

async function onKeysArrived() {
  const got = await loadConvKeys();
  if (!got.length) return;
  for (const id of got) {
    const c = convs.get(id);
    if (c) c.last_p = await decryptMsg(id, c.last_sender, c.last_ct, c.last_iv);
    for (const m of history.get(id) || []) { m.p = null; await decryptInto(m); }
    shareConvKey(id).catch(() => {});
  }
  renderChats();
  if (got.includes(activeId)) renderMessages();
}

async function addMessage(m, fromServer = false) {
  if (!me) return;
  let c = convs.get(m.conversation_id);
  if (!c) { await loadChats(); c = convs.get(m.conversation_id); if (!c) return; }
  await loadPeople([m.sender_id]);
  if (!convKeys.has(c.id)) await loadConvKeys();
  await decryptInto(m);

  const h = history.get(c.id);
  const isNew = !h || !h.some((x) => x.id === m.id);
  if (h && isNew) { h.push(m); h.sort((x, y) => ts(x.created_at) - ts(y.created_at)); }

  if (!c.last_message_at || ts(c.last_message_at) <= ts(m.created_at)) {
    c.last_message_at = m.created_at;
    c.last_ct = m.ct; c.last_iv = m.iv; c.last_p = m.p;
    c.last_sender = m.sender_id;
  }
  if (m.sender_id === me.id) c.last_read_at = m.created_at;

  if (c.id === activeId) {
    if (h) renderMessages();
    if (m.sender_id !== me.id) markRead(c.id);
  }
  if (fromServer && isNew && m.sender_id !== me.id && !(c.id === activeId && !document.hidden) && prefs.sound) ding();
  renderChats();
}

/* ---------- Звук ---------- */
let audioCtx = null;
function ding() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const t = audioCtx.currentTime;
    for (const [i, f] of [[0, 880], [0.12, 1320]]) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i);
      g.gain.exponentialRampToValueAtTime(0.18, t + i + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i); o.stop(t + i + 0.3);
    }
  } catch {}
}

/* ---------- Push-уведомления ---------- */
async function setupPush(enable) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error(/iPhone|iPad/.test(navigator.userAgent)
      ? 'На iPhone сначала установите приложение: «Поделиться» → «На экран Домой», и откройте его с иконки'
      : 'Этот браузер не поддерживает push-уведомления');
  }
  const reg = swReg || await navigator.serviceWorker.ready;
  if (enable) {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Разрешите уведомления в настройках браузера');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(VAPID_PUBLIC_KEY) });
    const j = sub.toJSON();
    const { error } = await sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
    if (error) throw error;
  } else {
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
  }
}

/* ---------- Окна ---------- */
function openModal(html, opts = {}) {
  $('modalRoot').innerHTML = `<div class="overlay" id="overlay"><div class="modal">${html}</div></div>`;
  if (!opts.locked) $('overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'overlay') closeModal(); });
  $('modalRoot').querySelectorAll('[data-close]').forEach((b) => b.onclick = closeModal);
  $('modalRoot').dataset.locked = opts.locked ? '1' : '';
}
function closeModal() { $('modalRoot').innerHTML = ''; $('modalRoot').dataset.locked = ''; }
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('modalRoot').dataset.locked) closeModal();
  document.querySelector('.lightbox')?.remove();
});
const closeBtn = '<button class="icon-btn" data-close title="Закрыть">✕</button>';
const parseNicks = (s) => s.split(/[\s,;]+/).map((x) => x.replace(/^@/, '').toLowerCase()).filter(Boolean);

/* Новая группа */
$('newGroupBtn').onclick = () => {
  openModal(`
    <div class="modal-head"><h3>Новая группа 👥</h3>${closeBtn}</div>
    <input id="gTitle" placeholder="Название, например «Друзья»" maxlength="60">
    <input id="gNicks" placeholder="Ники участников через пробел: anya max_dev">
    <button class="primary grad" id="gCreate">Создать группу</button>
    <div class="msg" id="gMsg"></div>`);
  $('gTitle').focus();
  $('gCreate').onclick = async () => {
    const title = $('gTitle').value.trim();
    const nicks = parseNicks($('gNicks').value);
    if (!title) return say('gMsg', 'Придумайте название группы');
    $('gCreate').disabled = true;
    const { data: missing } = await checkNicks(nicks);
    const { data, error } = await sb.rpc('create_group', { group_title: title, usernames: nicks });
    $('gCreate').disabled = false;
    if (error) return say('gMsg', humanError(error));
    closeModal();
    await loadChats();
    await openChat(data);
    if (missing.length) alertInline('Не нашли: ' + missing.map((n) => '@' + n).join(', '));
  };
};

async function checkNicks(nicks) {
  if (!nicks.length) return { data: [] };
  const { data } = await sb.from('profiles').select('username').in('username', nicks);
  const found = new Set((data || []).map((p) => p.username));
  return { data: nicks.filter((n) => !found.has(n)) };
}

/* О чате */
async function openChatInfo(id) {
  const c = convs.get(id);
  if (!c) return;
  if (!c.is_group) {
    const o = otherOf(c);
    await loadPubKeys([o], true);
    const theirs = pubKeys.get(o);
    openModal(`
      <div class="modal-head"><h3>Профиль</h3>${closeBtn}</div>
      <div class="center">${avatarOf(o, 'lg')}<div class="name"></div><div class="nick"></div></div>
      <div class="section">
        <h4>🔒 Код безопасности</h4>
        <div id="safety" class="safety"></div>
        <div class="small">Сравните этот код с кодом на телефоне друга: при встрече или по звонку.
          Совпадает — значит, вашу переписку никто не подменяет.</div>
      </div>`);
    document.querySelector('.modal .name').textContent = nameOf(o);
    document.querySelector('.modal .nick').textContent = nickOf(o);
    if (theirs?.fp) {
      $('safety').innerHTML = (await safetyCode(myFp, theirs.fp)).map((g) => `<span>${g}</span>`).join('');
    } else {
      $('safety').outerHTML = '<div class="small">Собеседник ещё не включил шифрование: попросите его открыть новую версию приложения.</div>';
    }
    return;
  }
  openModal(`
    <div class="modal-head"><h3>Группа</h3>${closeBtn}</div>
    <div class="center">${convAvatar(c, 'lg')}</div>
    <div class="section">
      <h4>Название</h4>
      <div class="inline"><input id="rTitle" maxlength="60"><button class="secondary" id="rSave">Сохранить</button></div>
    </div>
    <div class="section">
      <h4>Участники</h4>
      <div id="mList" style="display:grid;gap:10px"></div>
      <div class="inline"><input id="addNicks" placeholder="Добавить по нику"><button class="secondary" id="addBtn">＋</button></div>
    </div>
    <div class="msg" id="iMsg"></div>
    <button class="secondary danger" id="leaveBtn">🚪 Выйти из группы</button>`);
  $('rTitle').value = c.title || '';
  await loadPubKeys(c.member_ids || []);
  const list = $('mList');
  for (const uid of c.member_ids || []) {
    const row = document.createElement('div');
    row.className = 'member';
    row.innerHTML = `${avatarOf(uid, 'xs')}<div><div class="n"></div><div class="u"></div></div>`;
    row.querySelector('.n').textContent = nameOf(uid) + (uid === me.id ? ' (вы)' : '');
    row.querySelector('.u').textContent = nickOf(uid) + (pubKeys.get(uid)?.fp ? ' · 🔒' : ' · ждём включения шифрования');
    list.appendChild(row);
  }
  $('rSave').onclick = async () => {
    const { error } = await sb.rpc('rename_group', { conv: id, new_title: $('rTitle').value });
    if (error) return say('iMsg', humanError(error));
    await loadChats(); renderHeader(); say('iMsg', 'Название сохранено ✨', 'ok');
  };
  $('addBtn').onclick = async () => {
    const nicks = parseNicks($('addNicks').value);
    if (!nicks.length) return;
    const { data: missing } = await checkNicks(nicks);
    const { error } = await sb.rpc('add_group_members', { conv: id, usernames: nicks });
    if (error) return say('iMsg', humanError(error));
    await loadChats(); renderHeader();
    await shareConvKey(id).catch(() => {});
    await openChatInfo(id);
    say('iMsg', missing.length ? 'Не нашли: ' + missing.map((n) => '@' + n).join(', ') : 'Добавили 🎉', missing.length ? 'err' : 'ok');
  };
  $('leaveBtn').onclick = async () => {
    if (!confirm('Выйти из группы «' + (c.title || '') + '»?')) return;
    const { error } = await sb.from('conversation_members').delete().eq('conversation_id', id).eq('user_id', me.id);
    if (error) return say('iMsg', humanError(error));
    closeModal();
    convs.delete(id); history.delete(id); convKeys.delete(id);
    activeId = null; document.body.classList.remove('in-chat');
    showPlaceholder(); renderChats();
  };
}

/* Настройки */
$('settingsBtn').onclick = openSettings;
$('meWho').onclick = openSettings;

function openSettings() {
  const p = people.get(me.id);
  let hue = p.avatar_hue ?? hueFor(p.username);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  openModal(`
    <div class="modal-head"><h3>Настройки ⚙️</h3>${closeBtn}</div>
    <div class="center"><div id="sAv"></div><div class="nick"></div></div>
    <div class="section">
      <h4>Профиль</h4>
      <input id="sName" maxlength="40" placeholder="Имя, которое видят друзья">
      <div class="swatches" id="sHues"></div>
      <button class="primary grad" id="sSave">Сохранить профиль</button>
    </div>
    <div class="section" id="sAppSec">
      <h4>📲 Приложение</h4>
      <div id="sApp"></div>
    </div>
    <div class="section">
      <h4>Оформление и уведомления</h4>
      <div class="row"><div class="lbl">🌙 Тёмная тема</div><label class="switch"><input type="checkbox" id="sDark"><span></span></label></div>
      <div class="row"><div class="lbl">🔔 Звук в открытом приложении</div><label class="switch"><input type="checkbox" id="sSound"><span></span></label></div>
      <div class="row"><div class="lbl">💬 Push-уведомления<small>Приходят, даже когда приложение закрыто</small></div><label class="switch"><input type="checkbox" id="sNotify"><span></span></label></div>
    </div>
    <div class="section">
      <h4>🔐 Шифрование</h4>
      <div class="small" style="text-align:left">Сквозное шифрование включено. Ключ этого устройства: <b id="sFp"></b></div>
      <input id="sOld" type="password" placeholder="Текущий секретный код" autocomplete="off">
      <div class="inline"><input id="sNew" type="password" placeholder="Новый код (от 8 символов)" autocomplete="new-password"><button class="secondary" id="sCodeBtn">Сменить</button></div>
    </div>
    <div class="section">
      <h4>Аккаунт</h4>
      <div class="row"><div class="lbl">Email<small id="sEmail"></small></div></div>
      <div class="inline"><input id="sPass" type="password" placeholder="Новый пароль" autocomplete="new-password"><button class="secondary" id="sPassBtn">Сменить</button></div>
    </div>
    <div class="msg" id="sMsg"></div>
    <button class="secondary danger" id="sLogout">🚪 Выйти из аккаунта</button>`);

  document.querySelector('.modal .nick').textContent = '@' + p.username;
  $('sName').value = p.display_name || '';
  $('sEmail').textContent = me.email || '';
  $('sFp').textContent = (myFp || '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim();
  $('sDark').checked = prefs.theme === 'dark';
  $('sSound').checked = prefs.sound;
  $('sNotify').checked = prefs.notify && 'Notification' in window && Notification.permission === 'granted';

  if (standalone) $('sApp').innerHTML = '<div class="small" style="text-align:left">✅ Приложение установлено</div>';
  else if (installPrompt) {
    $('sApp').innerHTML = '<button class="primary grad" id="sInstall" style="width:100%">Установить приложение</button>';
    $('sInstall').onclick = async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; openSettings(); };
  } else if (isIOS) $('sApp').innerHTML = '<div class="small" style="text-align:left">На iPhone: нажмите «Поделиться» ⬆️ → «На экран Домой». Push-уведомления на iPhone работают только в установленном приложении.</div>';
  else $('sApp').innerHTML = '<div class="small" style="text-align:left">Откройте сайт в Chrome или Edge: в адресной строке появится значок установки ⊕. На Android: меню ⋮ → «Установить приложение».</div>';

  const drawAv = () => { $('sAv').innerHTML = avatarHTML($('sName').value.trim() || p.username, hue, 'lg'); };
  const drawHues = () => {
    $('sHues').innerHTML = '';
    for (const h of HUES) {
      const b = document.createElement('button');
      b.className = 'swatch' + (h === hue ? ' on' : '');
      b.style.background = `linear-gradient(135deg, hsl(${h} 80% 66%), hsl(${(h + 40) % 360} 75% 58%))`;
      b.onclick = () => { hue = h; drawHues(); drawAv(); };
      $('sHues').appendChild(b);
    }
  };
  drawAv(); drawHues();
  $('sName').oninput = drawAv;

  $('sSave').onclick = async () => {
    const display_name = $('sName').value.trim() || null;
    const { error } = await sb.from('profiles').update({ display_name, avatar_hue: hue }).eq('id', me.id);
    if (error) return say('sMsg', humanError(error));
    Object.assign(p, { display_name, avatar_hue: hue });
    renderMe(); renderChats(); if (activeId) { renderHeader(); renderMessages(); }
    say('sMsg', 'Профиль сохранён ✨', 'ok');
  };
  $('sDark').onchange = () => { prefs.theme = $('sDark').checked ? 'dark' : 'light'; savePrefs(); applyTheme(); };
  $('sSound').onchange = () => { prefs.sound = $('sSound').checked; savePrefs(); if (prefs.sound) ding(); };
  $('sNotify').onchange = async () => {
    const want = $('sNotify').checked;
    try {
      await setupPush(want);
      prefs.notify = want; savePrefs();
      say('sMsg', want ? 'Push-уведомления включены 🔔' : 'Push-уведомления выключены', 'ok');
    } catch (err) { $('sNotify').checked = !want; say('sMsg', humanError(err)); }
  };
  $('sCodeBtn').onclick = async () => {
    const oldCode = $('sOld').value, newCode = $('sNew').value;
    if (newCode.length < 8) return say('sMsg', 'Новый код должен быть от 8 символов');
    $('sCodeBtn').disabled = true;
    say('sMsg', 'Проверяю код…', 'ok');
    try {
      const { data: b, error } = await sb.from('key_backups').select('backup').eq('user_id', me.id).single();
      if (error) throw error;
      let privJwk;
      try { privJwk = await openBackup(b.backup, oldCode); } catch { throw new Error('Текущий код неверный'); }
      const backup = await makeBackup(privJwk, newCode);
      const r = await sb.from('key_backups').update({ backup, updated_at: new Date().toISOString() }).eq('user_id', me.id);
      if (r.error) throw r.error;
      $('sOld').value = ''; $('sNew').value = '';
      say('sMsg', 'Секретный код изменён 🔐', 'ok');
    } catch (err) { say('sMsg', humanError(err)); }
    $('sCodeBtn').disabled = false;
  };
  $('sPassBtn').onclick = async () => {
    const password = $('sPass').value;
    if (password.length < 6) return say('sMsg', 'Пароль должен быть от 6 символов');
    const { error } = await sb.auth.updateUser({ password });
    if (error) return say('sMsg', humanError(error));
    $('sPass').value = '';
    say('sMsg', 'Пароль изменён 🔐', 'ok');
  };
  $('sLogout').onclick = async () => {
    await setupPush(false).catch(() => {});
    await idbDel('me:' + me.id).catch(() => {});   // на этом устройстве ключ удаляется, при входе понадобится код
    await sb.auth.signOut();
  };
}

/* ---------- Мелочи ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
function timeShort(iso) {
  const d = new Date(iso), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

const { data: { session } } = await sb.auth.getSession();
if (!session) $('auth').classList.remove('hidden');
