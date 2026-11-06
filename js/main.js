import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from '../config.js';
import * as E2E from './crypto.js';

/* =====================================================================
   Утилиты
   ===================================================================== */
const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const BUCKET = 'chat-images';
const HUES = [230, 265, 300, 340, 15, 40, 150, 185];
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

/** Создать элемент: h('div', { class: 'x', text: '…', onclick }, ...дети) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'vars') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'i');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}
function setIcon(button, name) { button.querySelector('use')?.setAttribute('href', '#i-' + name); }

function say(el, text, kind = 'err') {
  if (typeof el === 'string') el = $(el);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'note' + (text ? ' ' + kind : '');
}
const ts = (x) => (x ? Date.parse(x) : 0);
const byTime = (a, b) => ts(a.created_at) - ts(b.created_at);
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const timeOf = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function shortTime(iso) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? timeOf(iso)
    : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
const dayOf = (iso) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const hueOf = (text = '') => { let h = 0; for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const parseNicks = (s) => s.split(/[\s,;]+/).map((x) => x.replace(/^@/, '').toLowerCase()).filter(Boolean);
const isDesktop = () => matchMedia('(min-width: 721px)').matches;

function humanError(err) {
  const m = (err && err.message) || String(err);
  const rules = [
    [/Invalid login credentials/i, 'Неверный email или пароль'],
    [/Email not confirmed/i, 'Сначала подтвердите email по ссылке из письма'],
    [/already registered/i, 'Этот email уже зарегистрирован'],
    [/rate limit/i, 'Слишком много попыток, подождите немного'],
    [/Failed to fetch|NetworkError/i, 'Нет связи с сервером. Проверьте интернет'],
    [/should be different/i, 'Новый пароль совпадает со старым'],
    [/Password should be/i, 'Пароль слишком короткий: нужно от 6 символов'],
  ];
  for (const [re, text] of rules) if (re.test(m)) return text;
  if (/(user_keys|key_backups|conversation_keys|messages_e2ee|last_ct|my_chats|conversation)/i.test(m)
      && /(not find|does not exist|schema cache)/i.test(m)) return 'База не обновлена: запустите SQL-обновления в Supabase';
  return m;
}

if (SUPABASE_URL.includes('ВАШ') || SUPABASE_KEY.includes('ВАШ')) {
  $('configWarn').hidden = false;
  throw new Error('config.js не заполнен');
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

/* =====================================================================
   Состояние
   ===================================================================== */
const state = {
  me: null,                 // { id, email }
  people: new Map(),        // id -> { username, display_name, avatar_hue }
  chats: new Map(),         // id -> строка из my_chats() + last_p, keyWarn
  history: new Map(),       // id чата -> [сообщения]
  images: new Map(),        // путь -> blob: ссылка на расшифрованное фото
  activeId: null,
  channel: null,
};
const keys = {
  priv: null,               // мой секретный ключ (неизвлекаемый)
  fp: null,                 // отпечаток моего публичного ключа
  chat: new Map(),          // id чата -> ключ AES-GCM
  pub: new Map(),           // id пользователя -> { jwk, fp }
  trusted: {},              // id пользователя -> отпечаток, которому доверяем (на этом устройстве)
};

/* =====================================================================
   Оформление и настройки устройства
   ===================================================================== */
const prefs = { style: 'classic', mode: 'auto', sound: true, notify: false };
try {
  const saved = JSON.parse(localStorage.getItem('prefs') || '{}');
  if (saved.theme && !saved.mode) saved.mode = saved.theme;   // старый формат
  Object.assign(prefs, saved);
} catch {}
const savePrefs = () => { try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch {} };
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const resolvedMode = () => (prefs.mode === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : prefs.mode);

function applyTheme() {
  const root = document.documentElement;
  root.dataset.style = prefs.style;
  root.dataset.mode = resolvedMode();
  setIcon($('modeBtn'), resolvedMode() === 'dark' ? 'sun' : 'moon');
  const bg = getComputedStyle(root).getPropertyValue('--surface').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#ffffff');
}
darkQuery.addEventListener('change', () => { if (prefs.mode === 'auto') applyTheme(); });
applyTheme();
$('modeBtn').onclick = () => { prefs.mode = resolvedMode() === 'dark' ? 'light' : 'dark'; savePrefs(); applyTheme(); };

/* =====================================================================
   Приложение (PWA)
   ===================================================================== */
let swReg = null;
let installPrompt = null;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then((r) => { swReg = r; }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.open && state.me) openChat(e.data.open); });
}
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

/* =====================================================================
   Окна
   ===================================================================== */
let modalLocked = false;
function openModal({ title, locked = false }, ...body) {
  modalLocked = locked;
  const head = h('div', { class: 'modal-head' }, h('h3', { text: title }),
    locked ? null : h('button', { class: 'icon-btn', title: 'Закрыть', onclick: closeModal }, icon('close')));
  const overlay = h('div', { class: 'overlay' }, h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, head, ...body));
  if (!locked) overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
  $('modalRoot').replaceChildren(overlay);
  return overlay;
}
function closeModal() { modalLocked = false; $('modalRoot').replaceChildren(); }
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelector('.lightbox')?.remove();
  if (!modalLocked) closeModal();
});
const section = (title, ...kids) => h('div', { class: 'section' }, title ? h('div', { class: 'section-title', text: title }) : null, ...kids);
const note = () => h('p', { class: 'note', role: 'status' });
const toggle = (checked, onchange) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange }), h('span'));
function segmented(options, value, onpick) {
  const wrap = h('div', { class: 'segmented' });
  for (const [val, label] of options) {
    wrap.append(h('button', {
      type: 'button', class: val === value ? 'on' : '', text: label,
      onclick: () => { wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.textContent === label)); onpick(val); },
    }));
  }
  return wrap;
}

/* =====================================================================
   Люди и аватары
   ===================================================================== */
async function loadPeople(ids) {
  const missing = [...new Set(ids)].filter((id) => id && !state.people.has(id));
  if (!missing.length) return;
  const { data } = await sb.from('profiles').select('id, username, display_name, avatar_hue').in('id', missing);
  for (const p of data || []) state.people.set(p.id, p);
}
const nameOf = (id) => { const p = state.people.get(id); return p ? (p.display_name || p.username) : '…'; };
const nickOf = (id) => '@' + (state.people.get(id)?.username || '');
const hueOfUser = (id) => { const p = state.people.get(id) || {}; return p.avatar_hue ?? hueOf(p.username); };

function avatar(label, hue, size = '', badge = null) {
  return h('span', { class: 'avatar ' + size, vars: { '--h': hue } }, (label || '?')[0].toUpperCase(),
    badge ? h('span', { class: 'badge' }, icon(badge)) : null);
}
const userAvatar = (id, size) => avatar(nameOf(id), hueOfUser(id), size);
const otherOf = (c) => (c.member_ids || []).find((id) => id !== state.me.id);
const titleOf = (c) => (c.is_group ? c.title || 'Группа' : nameOf(otherOf(c)));
const chatAvatar = (c, size) => (c.is_group ? avatar(c.title, hueOf(c.title), size, 'users') : userAvatar(otherOf(c), size));

/* =====================================================================
   Шифрование: мои ключи
   ===================================================================== */
async function loadPubKeys(ids, force = false) {
  const need = [...new Set(ids)].filter((id) => force || !keys.pub.has(id));
  if (!need.length) return;
  const { data } = await sb.from('user_keys').select('user_id, public_key, fingerprint').in('user_id', need);
  for (const r of data || []) keys.pub.set(r.user_id, { jwk: r.public_key, fp: r.fingerprint });
}

async function useIdentity(privateJwk, publicJwk, fp) {
  keys.priv = await E2E.importPrivate(privateJwk);
  keys.fp = fp;
  keys.pub.set(state.me.id, { jwk: publicJwk, fp });
  await E2E.store.set('me:' + state.me.id, { priv: keys.priv, fp });
}

async function createIdentity(code) {
  const id = await E2E.generateIdentity();
  const backup = await E2E.sealBackup(id.privateJwk, code);
  const now = new Date().toISOString();
  let r = await sb.from('key_backups').upsert({ user_id: state.me.id, backup, updated_at: now });
  if (r.error) throw r.error;
  r = await sb.from('user_keys').upsert({ user_id: state.me.id, public_key: id.publicJwk, fingerprint: id.fingerprint, updated_at: now });
  if (r.error) throw r.error;
  await useIdentity(id.privateJwk, id.publicJwk, id.fingerprint);
}

async function ensureIdentity() {
  const { data: row, error } = await sb.from('user_keys').select('public_key, fingerprint').eq('user_id', state.me.id).maybeSingle();
  if (error) throw error;
  const local = await E2E.store.get('me:' + state.me.id).catch(() => null);
  if (row && local && local.fp === row.fingerprint) {
    keys.priv = local.priv;
    keys.fp = local.fp;
    keys.pub.set(state.me.id, { jwk: row.public_key, fp: row.fingerprint });
  } else {
    await identityDialog(row);
  }
  keys.trusted = (await E2E.store.get('trusted:' + state.me.id).catch(() => null)) || {};
}
const saveTrusted = () => E2E.store.set('trusted:' + state.me.id, keys.trusted).catch(() => {});

function identityDialog(row) {
  return new Promise((resolve) => {
    const restore = !!row;
    const code = h('input', { type: 'password', placeholder: restore ? 'Секретный код' : 'Секретный код, от 8 символов',
      autocomplete: restore ? 'off' : 'new-password' });
    const code2 = restore ? null : h('input', { type: 'password', placeholder: 'Повторите код', autocomplete: 'new-password' });
    const msg = note();
    const go = h('button', { class: 'btn btn-primary btn-block', text: restore ? 'Открыть переписку' : 'Включить шифрование' });
    const forgot = restore ? h('button', { class: 'btn btn-block', text: 'Забыл код' }) : null;

    openModal({ title: restore ? 'Введите секретный код' : 'Сквозное шифрование', locked: true },
      h('p', { text: restore
        ? 'Вы вошли на новом устройстве. Код нужен, чтобы расшифровать переписку.'
        : 'Сообщения и фото увидят только участники чата. Придумайте секретный код — лучше фразу из нескольких слов. Он нужен для входа с других устройств. Если забудете его, старые сообщения откроются, только когда друзья подтвердят ваш новый ключ.' }),
      code, code2, go, msg, forgot);
    code.focus();

    go.onclick = async () => {
      go.disabled = true;
      try {
        if (restore) {
          say(msg, 'Проверяю код…', 'ok');
          const { data: b, error } = await sb.from('key_backups').select('backup').eq('user_id', state.me.id).maybeSingle();
          if (error) throw error;
          if (!b) throw new Error('Резервная копия не найдена. Нажмите «Забыл код».');
          let jwk;
          try { jwk = await E2E.openBackup(b.backup, code.value); } catch { throw new Error('Неверный код'); }
          if (jwk.x !== row.public_key.x) throw new Error('Копия ключа устарела. Нажмите «Забыл код».');
          await useIdentity(jwk, row.public_key, row.fingerprint);
        } else {
          if (code.value.length < 8) throw new Error('Код должен быть от 8 символов');
          if (code.value !== code2.value) throw new Error('Коды не совпадают');
          say(msg, 'Создаю ключи…', 'ok');
          await createIdentity(code.value);
        }
        closeModal();
        resolve();
      } catch (err) {
        say(msg, humanError(err));
        go.disabled = false;
      }
    };
    code.onkeydown = (e) => { if (e.key === 'Enter') { if (code2) code2.focus(); else go.click(); } };
    if (code2) code2.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
    if (forgot) forgot.onclick = () => {
      if (!confirm('Создать новые ключи? Старые сообщения станут видны, когда друзья откроют чат и подтвердят ваш новый ключ.')) return;
      identityDialog(null).then(resolve);
    };
  });
}

/* =====================================================================
   Шифрование: ключи чатов
   ===================================================================== */
const aadMsg = (chatId, senderId) => chatId + '|' + senderId;

async function loadChatKeys() {
  const { data } = await sb.from('conversation_keys').select('conversation_id, for_fingerprint, wrapped').eq('user_id', state.me.id);
  const got = [];
  for (const r of data || []) {
    if (r.for_fingerprint !== keys.fp || keys.chat.has(r.conversation_id)) continue;
    try { keys.chat.set(r.conversation_id, await E2E.unwrapChatKey(r.wrapped, keys.priv)); got.push(r.conversation_id); } catch {}
  }
  return got;
}

/** true — ключ чата есть (получен или только что создан). */
async function ensureChatKey(chatId) {
  if (keys.chat.has(chatId)) return true;
  const { data: r } = await sb.from('conversation_keys').select('for_fingerprint, wrapped')
    .eq('conversation_id', chatId).eq('user_id', state.me.id).maybeSingle();
  if (r) {
    if (r.for_fingerprint !== keys.fp) return false;              // зашифрован для старого ключа — ждём друзей
    try { keys.chat.set(chatId, await E2E.unwrapChatKey(r.wrapped, keys.priv)); return true; } catch { return false; }
  }
  const { data: won, error } = await sb.rpc('claim_conversation_key', { conv: chatId });
  if (error || !won) return false;
  keys.chat.set(chatId, await E2E.newChatKey());
  await shareChatKey(chatId);
  return true;
}

/** Отдать ключ чата участникам, у которых его нет. Сменившиеся ключи — только после подтверждения. */
async function shareChatKey(chatId) {
  const key = keys.chat.get(chatId);
  const c = state.chats.get(chatId);
  if (!key || !c) return;
  const members = c.member_ids || [];
  await loadPubKeys(members);
  const { data: rows } = await sb.from('conversation_keys').select('user_id, for_fingerprint').eq('conversation_id', chatId);
  const have = new Map((rows || []).map((r) => [r.user_id, r.for_fingerprint]));
  const out = [], warn = [];
  let trustedChanged = false;
  for (const uid of members) {
    const pk = keys.pub.get(uid);
    if (!pk?.jwk) continue;                                           // ещё не включил шифрование
    if (uid !== state.me.id) {
      if (!keys.trusted[uid]) { keys.trusted[uid] = pk.fp; trustedChanged = true; }
      if (keys.trusted[uid] !== pk.fp) { warn.push(uid); continue; }
    }
    if (have.get(uid) === pk.fp) continue;
    out.push({ conversation_id: chatId, user_id: uid, for_fingerprint: pk.fp, wrapped: await E2E.wrapChatKey(key, pk.jwk) });
  }
  if (trustedChanged) await saveTrusted();
  if (out.length) await sb.from('conversation_keys').upsert(out, { onConflict: 'conversation_id,user_id' });
  const changed = (c.keyWarn || []).join() !== warn.join();
  c.keyWarn = warn;
  if (changed && chatId === state.activeId) renderMessages();
}

async function shareAllChatKeys() {
  for (const id of keys.chat.keys()) if (state.chats.has(id)) await shareChatKey(id).catch(() => {});
}

async function decryptMessage(m) {
  if (m.p && !m.p.bad) return m;
  m.p = await E2E.openJson(keys.chat.get(m.conversation_id), m.ct, m.iv, aadMsg(m.conversation_id, m.sender_id));
  return m;
}

/* =====================================================================
   Вход и регистрация
   ===================================================================== */
let authMode = 'login';
function setAuthMode(m) {
  authMode = m;
  $('tabLogin').classList.toggle('on', m === 'login');
  $('tabSignup').classList.toggle('on', m === 'signup');
  $('usernameField').hidden = m === 'login';
  $('authBtn').textContent = m === 'login' ? 'Войти' : 'Создать аккаунт';
  $('authSub').textContent = m === 'login' ? 'С возвращением' : 'Пара секунд — и вы с нами';
  $('password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  say('authMsg', '');
}
$('tabLogin').onclick = () => setAuthMode('login');
$('tabSignup').onclick = () => setAuthMode('signup');

$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  const password = $('password').value;
  $('authBtn').disabled = true;
  try {
    if (authMode === 'login') {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } else {
      const username = $('username').value.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,24}$/.test(username)) throw new Error('Ник: 3–24 символа, латиница, цифры или _');
      const { data: free, error: e1 } = await sb.rpc('username_available', { name: username });
      if (e1) throw e1;
      if (!free) throw new Error('Этот ник уже занят');
      const { data, error } = await sb.auth.signUp({
        email, password, options: { data: { username }, emailRedirectTo: location.origin + location.pathname },
      });
      if (error) throw error;
      if (!data.session) say('authMsg', 'Готово! Подтвердите email по ссылке из письма и войдите.', 'ok');
    }
  } catch (err) {
    say('authMsg', humanError(err));
  } finally {
    $('authBtn').disabled = false;
  }
};

sb.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => (session ? startApp(session.user) : stopApp()), 0);
});

/* =====================================================================
   Запуск и выход
   ===================================================================== */
async function startApp(user) {
  if (state.me?.id === user.id) return;
  state.me = { id: user.id, email: user.email };
  await loadPeople([user.id]);
  if (!state.people.has(user.id)) state.people.set(user.id, { username: user.user_metadata?.username || 'me' });

  $('auth').hidden = true;
  $('app').hidden = false;
  renderMe();
  try {
    await ensureIdentity();
  } catch (err) {
    $('chatList').replaceChildren(h('div', { class: 'list-empty', text: humanError(err) }));
    return;
  }
  await loadChatKeys();
  await loadChats();
  subscribe();
  shareAllChatKeys();
  if (prefs.notify && 'Notification' in window && Notification.permission === 'granted') setupPush(true).catch(() => {});

  const deep = location.hash.match(/c=([0-9a-f-]{36})/);
  if (deep) { window.history.replaceState(null, '', location.pathname); openChat(deep[1]); }
}

function stopApp() {
  state.me = null;
  state.activeId = null;
  state.people.clear(); state.chats.clear(); state.history.clear();
  for (const url of state.images.values()) URL.revokeObjectURL(url);
  state.images.clear();
  keys.priv = null; keys.fp = null; keys.chat.clear(); keys.pub.clear(); keys.trusted = {};
  if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
  closeModal();
  $('app').hidden = true;
  $('auth').hidden = false;
  document.body.classList.remove('in-chat');
  showPlaceholder();
  document.title = 'Мессенджер';
}

function renderMe() {
  const p = state.people.get(state.me.id);
  $('meName').textContent = p.display_name || p.username;
  $('meNick').textContent = '@' + p.username;
  $('meAvatar').replaceChildren(userAvatar(state.me.id, 'sm'));
}

/* =====================================================================
   Список чатов
   ===================================================================== */
const isUnread = (c) => c.last_sender && c.last_sender !== state.me.id && ts(c.last_read_at) < ts(c.last_message_at);

async function loadChats() {
  const { data, error } = await sb.rpc('my_chats');
  if (error) { $('chatList').replaceChildren(h('div', { class: 'list-empty', text: humanError(error) })); return; }
  const previous = new Map(state.chats);
  state.chats.clear();
  for (const c of data) {
    c.keyWarn = previous.get(c.id)?.keyWarn;
    c.last_p = await E2E.openJson(keys.chat.get(c.id), c.last_ct, c.last_iv, aadMsg(c.id, c.last_sender));
    state.chats.set(c.id, c);
  }
  await loadPeople(data.flatMap((c) => c.member_ids || []));
  renderChats();
}

function previewText(p) {
  if (!p) return 'Зашифровано';
  if (p.bad) return 'Не удалось расшифровать';
  return p.img ? 'Фото' + (p.t ? ': ' + p.t : '') : p.t;
}
function previewOf(c) {
  if (!c.last_sender) return c.is_group ? 'Группа создана' : 'Новый чат';
  const who = c.last_sender === state.me.id ? 'Вы: ' : c.is_group ? nameOf(c.last_sender) + ': ' : '';
  return who + previewText(c.last_p);
}

function renderChats() {
  const items = [...state.chats.values()].sort((a, b) => ts(b.last_message_at) - ts(a.last_message_at));
  const unread = items.filter(isUnread).length;
  document.title = unread ? `(${unread}) Мессенджер` : 'Мессенджер';
  if ('setAppBadge' in navigator) (unread ? navigator.setAppBadge(unread) : navigator.clearAppBadge()).catch(() => {});

  if (!items.length) {
    $('chatList').replaceChildren(h('div', { class: 'list-empty', text: 'Чатов пока нет. Найдите друга по нику или создайте группу.' }));
    return;
  }
  $('chatList').replaceChildren(...items.map((c) => {
    const un = isUnread(c) && c.id !== state.activeId;
    return h('button', {
      class: 'chat-item' + (c.id === state.activeId ? ' active' : '') + (un ? ' unread' : ''),
      onclick: () => openChat(c.id),
    },
      chatAvatar(c),
      h('span', { class: 'chat-item-body' },
        h('span', { class: 'chat-item-row' },
          h('span', { class: 'chat-item-name', text: titleOf(c) }),
          h('span', { class: 'chat-item-time', text: c.last_sender ? shortTime(c.last_message_at) : '' })),
        h('span', { class: 'chat-item-row' },
          h('span', { class: 'chat-item-last', text: previewOf(c) }),
          un ? h('span', { class: 'unread-dot' }) : null)));
  }));
}

$('findForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('findInput').value.trim().toLowerCase().replace(/^@/, '');
  if (!q) return;
  if (q === state.people.get(state.me.id).username) return say('findMsg', 'Это же вы');
  const { data, error } = await sb.from('profiles').select('id, username, display_name, avatar_hue').eq('username', q).maybeSingle();
  if (error) return say('findMsg', humanError(error));
  if (!data) return say('findMsg', `Не нашли @${q} — проверьте ник`);
  state.people.set(data.id, data);
  const { data: chatId, error: e2 } = await sb.rpc('get_or_create_dm', { other: data.id });
  if (e2) return say('findMsg', humanError(e2));
  say('findMsg', '');
  $('findInput').value = '';
  await loadChats();
  await openChat(chatId);
};

/* =====================================================================
   Открытый чат
   ===================================================================== */
function showPlaceholder() {
  $('placeholder').hidden = false;
  $('messages').hidden = true;
  $('composer').hidden = true;
  $('uploading').hidden = true;
  $('chatTitle').textContent = '';
  $('chatStatus').replaceChildren();
  $('chatAvatar').replaceChildren();
}

function renderHeader() {
  const c = state.chats.get(state.activeId);
  if (!c) return;
  $('chatTitle').textContent = titleOf(c);
  $('chatAvatar').replaceChildren(chatAvatar(c, 'sm'));
  const n = (c.member_ids || []).length;
  $('chatStatus').replaceChildren(icon('lock'),
    c.is_group ? `${n} ${plural(n, 'участник', 'участника', 'участников')}` : nickOf(otherOf(c)));
}

async function openChat(id) {
  if (!state.chats.has(id)) await loadChats();
  if (!state.chats.has(id)) return;
  state.activeId = id;
  document.body.classList.add('in-chat');
  $('placeholder').hidden = true;
  $('messages').hidden = false;
  $('composer').hidden = false;
  renderHeader();
  markRead(id);
  renderChats();

  if (!state.history.has(id)) {
    $('messages').replaceChildren(h('div', { class: 'day', text: 'Загрузка…' }));
    const { data, error } = await sb.from('messages').select('id, conversation_id, sender_id, ct, iv, created_at')
      .eq('conversation_id', id).order('created_at', { ascending: false }).limit(200);
    if (error) { $('messages').replaceChildren(h('div', { class: 'inline-err', text: humanError(error) })); return; }
    const merged = new Map([...(state.history.get(id) || []), ...data].map((m) => [m.id, m]));
    state.history.set(id, [...merged.values()].sort(byTime));
    await loadPeople(state.history.get(id).map((m) => m.sender_id));
  }
  await ensureChatKey(id).catch(() => false);
  await Promise.all((state.history.get(id) || []).map(decryptMessage));
  if (state.activeId !== id) return;
  renderMessages();
  if (isDesktop()) $('text').focus();
  shareChatKey(id).catch(() => {});
}

$('backBtn').onclick = () => {
  document.body.classList.remove('in-chat');
  state.activeId = null;
  showPlaceholder();
  renderChats();
};
$('chatInfo').onclick = () => { if (state.activeId) openChatInfo(state.activeId); };

async function markRead(id) {
  const c = state.chats.get(id);
  if (!c || document.hidden) return;
  c.last_read_at = new Date(Math.max(Date.now(), ts(c.last_message_at))).toISOString();
  await sb.from('conversation_members').update({ last_read_at: c.last_read_at }).eq('conversation_id', id).eq('user_id', state.me.id);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.activeId) { markRead(state.activeId); renderChats(); }
});

function renderMessages() {
  const box = $('messages');
  const c = state.chats.get(state.activeId);
  const list = state.history.get(state.activeId) || [];
  const nodes = [];

  nodes.push(h('div', { class: 'sys-note' }, icon('lock'),
    h('span', { text: keys.chat.has(state.activeId)
      ? 'Сквозное шифрование: прочитать сообщения и фото могут только участники чата.'
      : 'Ждём ключ шифрования — он придёт, когда собеседник откроет приложение.' })));

  for (const uid of c?.keyWarn || []) {
    nodes.push(h('div', { class: 'warn' },
      h('div', {}, h('b', { text: nameOf(uid) }),
        ' сменил ключ безопасности: новое устройство без кода или сброс. Если это не так, переписку могут пытаться перехватить — сверьте код безопасности, прежде чем доверять.'),
      h('button', { class: 'btn', text: 'Доверять новому ключу', onclick: async () => {
        keys.trusted[uid] = keys.pub.get(uid)?.fp;
        await saveTrusted();
        await shareChatKey(state.activeId);
        renderMessages();
      } })));
  }

  if (!list.length) {
    nodes.push(h('div', { class: 'empty-chat', text: c?.is_group ? 'Группа готова. Напишите первое сообщение.' : 'Здесь пока пусто. Скажите «привет».' }));
  }

  let lastDay = '', prev = null;
  for (const m of list) {
    const day = dayOf(m.created_at);
    if (day !== lastDay) { nodes.push(h('div', { class: 'day', text: day })); lastDay = day; prev = null; }
    const continued = prev && prev.sender_id === m.sender_id && ts(m.created_at) - ts(prev.created_at) < 5 * 60e3;
    nodes.push(bubble(m, { showName: c?.is_group && m.sender_id !== state.me.id && !continued, continued }));
    prev = m;
  }
  box.replaceChildren(...nodes);
  resolveImages(box);
  box.scrollTop = box.scrollHeight;
}

function bubble(m, { showName, continued }) {
  const p = m.p;
  const mine = m.sender_id === state.me.id;
  const el = h('div', { class: ['msg', mine && 'mine', p?.img && 'photo', (!p || p.bad) && 'locked', continued && 'cont'].filter(Boolean).join(' ') });
  if (showName) el.append(h('div', { class: 'msg-from', vars: { '--h': hueOfUser(m.sender_id) }, text: nameOf(m.sender_id) }));
  if (p?.img) {
    const img = h('img', { class: 'msg-img', alt: 'Фото', dataset: { path: p.img.path, iv: p.img.iv, mime: p.img.mime || 'image/jpeg', chat: m.conversation_id } });
    if (p.img.w && p.img.h) img.style.aspectRatio = `${p.img.w} / ${p.img.h}`;
    img.onclick = () => img.src && openLightbox(img.src);
    el.append(img);
  }
  const text = !p ? 'Сообщение ещё не расшифровано' : p.bad ? 'Не удалось расшифровать' : p.t;
  if (text) el.append(h('div', { class: 'msg-text', text }));
  el.append(h('span', { class: 'msg-time', text: timeOf(m.created_at) }));
  return el;
}

function resolveImages(root) {
  for (const img of root.querySelectorAll('img[data-path]')) {
    const { path, iv, mime, chat } = img.dataset;
    if (state.images.has(path)) { img.src = state.images.get(path); continue; }
    (async () => {
      try {
        const key = keys.chat.get(chat);
        if (!key) return;
        const { data, error } = await sb.storage.from(BUCKET).download(path);
        if (error) throw error;
        const plain = await E2E.openBytes(key, await data.arrayBuffer(), iv, path);
        const url = URL.createObjectURL(new Blob([plain], { type: mime }));
        state.images.set(path, url);
        img.src = url;
        const box = $('messages');
        if (box.scrollHeight - box.scrollTop - box.clientHeight < 500) box.scrollTop = box.scrollHeight;
      } catch { img.alt = 'Фото не открылось'; }
    })();
  }
}

function openLightbox(src) {
  const lb = h('div', { class: 'lightbox', onclick: () => lb.remove() }, h('img', { src, alt: '' }));
  document.body.append(lb);
}

function inlineError(text) {
  const box = $('messages');
  box.append(h('div', { class: 'inline-err', text }));
  box.scrollTop = box.scrollHeight;
}

/* =====================================================================
   Отправка
   ===================================================================== */
const textArea = $('text');
function autosize() {
  textArea.style.height = 'auto';
  textArea.style.height = Math.min(textArea.scrollHeight + 2, 140) + 'px';
}
textArea.addEventListener('input', autosize);
textArea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && isDesktop()) { e.preventDefault(); $('composer').requestSubmit(); }
});
textArea.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); sendImage(f); }
});

async function canSend(chatId) {
  if (await ensureChatKey(chatId).catch(() => false)) return true;
  inlineError('Ключ шифрования ещё не получен — он придёт, когда собеседник откроет приложение.');
  return false;
}

async function insertMessage(chatId, payload) {
  const { ct, iv } = await E2E.sealJson(keys.chat.get(chatId), payload, aadMsg(chatId, state.me.id));
  const { data, error } = await sb.from('messages')
    .insert({ conversation_id: chatId, sender_id: state.me.id, ct, iv })
    .select('id, conversation_id, sender_id, ct, iv, created_at').single();
  if (error) throw error;
  data.p = payload;
  return data;
}

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const content = textArea.value.trim();
  const chatId = state.activeId;
  if (!content || !chatId || !(await canSend(chatId))) return;
  textArea.value = '';
  autosize();
  try {
    addMessage(await insertMessage(chatId, { t: content }));
  } catch (err) {
    textArea.value = content;
    autosize();
    inlineError('Не отправилось: ' + humanError(err));
  }
};

$('fileInput').onchange = () => {
  const f = $('fileInput').files[0];
  $('fileInput').value = '';
  if (f) sendImage(f);
};

async function sendImage(file) {
  const chatId = state.activeId;
  if (!chatId) return;
  if (!file.type.startsWith('image/')) return inlineError('Можно отправлять только картинки');
  if (!(await canSend(chatId))) return;
  const caption = textArea.value.trim();
  $('uploading').hidden = false;
  try {
    const { blob, type, w, h: height } = await shrinkImage(file);
    if (blob.size > 6 * 1024 * 1024) throw new Error('Картинка слишком большая');
    const path = `${chatId}/${crypto.randomUUID()}.bin`;
    const sealed = await E2E.sealBytes(keys.chat.get(chatId), await blob.arrayBuffer(), path);
    const { error } = await sb.storage.from(BUCKET).upload(path, new Blob([sealed.data], { type: 'application/octet-stream' }),
      { contentType: 'application/octet-stream' });
    if (error) throw error;
    state.images.set(path, URL.createObjectURL(blob));
    const msg = await insertMessage(chatId, { t: caption, img: { path, iv: sealed.iv, mime: type, w, h: height } });
    if (caption) { textArea.value = ''; autosize(); }
    addMessage(msg);
  } catch (err) {
    inlineError('Фото не отправилось: ' + humanError(err));
  } finally {
    $('uploading').hidden = true;
  }
}

/** Уменьшаем фото до 1600 px — экономит бесплатный 1 ГБ хранилища. */
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  if (file.type === 'image/gif' && file.size < 4 * 1024 * 1024) return { blob: file, type: 'image/gif', w: bmp.width, h: bmp.height };
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = h('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
  return { blob, type: 'image/jpeg', w: canvas.width, h: canvas.height };
}

/* =====================================================================
   Реальное время
   ===================================================================== */
function subscribe() {
  if (state.channel) sb.removeChannel(state.channel);
  const me = state.me.id;
  state.channel = sb.channel('inbox-' + me)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => addMessage(p.new, true))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversation_members', filter: `user_id=eq.${me}` },
      async () => { await loadChats(); shareAllChatKeys(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_keys', filter: `user_id=eq.${me}` },
      () => onChatKeysArrived())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_keys' }, async (p) => {
      const uid = p.new?.user_id;
      if (!uid || uid === me) return;
      await loadPubKeys([uid], true);
      for (const c of state.chats.values()) if ((c.member_ids || []).includes(uid)) shareChatKey(c.id).catch(() => {});
    })
    .subscribe();
}

async function onChatKeysArrived() {
  const got = await loadChatKeys();
  if (!got.length) return;
  for (const id of got) {
    const c = state.chats.get(id);
    if (c) c.last_p = await E2E.openJson(keys.chat.get(id), c.last_ct, c.last_iv, aadMsg(id, c.last_sender));
    for (const m of state.history.get(id) || []) { m.p = null; await decryptMessage(m); }
    shareChatKey(id).catch(() => {});
  }
  renderChats();
  if (got.includes(state.activeId)) renderMessages();
}

async function addMessage(m, fromServer = false) {
  if (!state.me) return;
  let c = state.chats.get(m.conversation_id);
  if (!c) { await loadChats(); c = state.chats.get(m.conversation_id); if (!c) return; }
  await loadPeople([m.sender_id]);
  if (!keys.chat.has(c.id)) await loadChatKeys();
  await decryptMessage(m);

  const hist = state.history.get(c.id);
  const isNew = !hist || !hist.some((x) => x.id === m.id);
  if (hist && isNew) { hist.push(m); hist.sort(byTime); }

  if (!c.last_message_at || ts(c.last_message_at) <= ts(m.created_at)) {
    Object.assign(c, { last_message_at: m.created_at, last_ct: m.ct, last_iv: m.iv, last_p: m.p, last_sender: m.sender_id });
  }
  if (m.sender_id === state.me.id) c.last_read_at = m.created_at;

  const visible = c.id === state.activeId && !document.hidden;
  if (c.id === state.activeId) {
    if (hist) renderMessages();
    if (m.sender_id !== state.me.id) markRead(c.id);
  }
  if (fromServer && isNew && m.sender_id !== state.me.id && !visible && prefs.sound) ding();
  renderChats();
}

/* =====================================================================
   Звук и push
   ===================================================================== */
let audioCtx = null;
function ding() {
  try {
    audioCtx ||= new AudioContext();
    const t = audioCtx.currentTime;
    for (const [delay, freq] of [[0, 880], [0.12, 1320]]) {
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.16, t + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.25);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.3);
    }
  } catch {}
}

async function setupPush(enable) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    throw new Error(isIOS
      ? 'На iPhone сначала установите приложение: «Поделиться» → «На экран Домой», и откройте его с иконки'
      : 'Этот браузер не поддерживает push-уведомления');
  }
  if (enable) {
    // На iPhone запрос разрешения должен идти сразу после нажатия — без ожиданий перед ним
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(isIOS
      ? 'Разрешите уведомления: Настройки iPhone → Уведомления → Мессенджер'
      : 'Разрешите уведомления в настройках браузера');
    const reg = swReg || await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: E2E.b64urlToBytes(VAPID_PUBLIC_KEY) });
    const j = sub.toJSON();
    const { error } = await sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
    if (error) throw error;
  } else {
    const reg = swReg || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
  }
}

/* =====================================================================
   Новая группа
   ===================================================================== */
async function missingNicks(nicks) {
  if (!nicks.length) return [];
  const { data } = await sb.from('profiles').select('username').in('username', nicks);
  const found = new Set((data || []).map((p) => p.username));
  return nicks.filter((n) => !found.has(n));
}

$('newGroupBtn').onclick = () => {
  const title = h('input', { placeholder: 'Например, «Друзья»', maxLength: 60 });
  const nicks = h('input', { placeholder: 'anya max_dev', autocapitalize: 'off', spellcheck: 'false' });
  const msg = note();
  const create = h('button', { class: 'btn btn-primary btn-block', text: 'Создать группу' });
  openModal({ title: 'Новая группа' },
    h('label', { class: 'field' }, h('span', { text: 'Название' }), title),
    h('label', { class: 'field' }, h('span', { text: 'Ники участников через пробел' }), nicks),
    create, msg);
  title.focus();
  create.onclick = async () => {
    if (!title.value.trim()) return say(msg, 'Придумайте название группы');
    create.disabled = true;
    const list = parseNicks(nicks.value);
    const missing = await missingNicks(list);
    const { data, error } = await sb.rpc('create_group', { group_title: title.value.trim(), usernames: list });
    create.disabled = false;
    if (error) return say(msg, humanError(error));
    closeModal();
    await loadChats();
    await openChat(data);
    if (missing.length) inlineError('Не нашли: ' + missing.map((n) => '@' + n).join(', '));
  };
};

/* =====================================================================
   О чате
   ===================================================================== */
async function openChatInfo(id) {
  const c = state.chats.get(id);
  if (!c) return;
  if (!c.is_group) {
    const other = otherOf(c);
    await loadPubKeys([other], true);
    const theirs = keys.pub.get(other);
    const codeBox = theirs?.fp
      ? h('div', { class: 'safety' }, ...(await E2E.safetyCode(keys.fp, theirs.fp)).map((g) => h('span', { text: g })))
      : h('p', { text: 'Собеседник ещё не включил шифрование — попросите его открыть новую версию приложения.' });
    openModal({ title: 'Профиль' },
      h('div', { class: 'profile-head' }, userAvatar(other, 'lg'),
        h('div', { class: 'profile-name', text: nameOf(other) }), h('div', { class: 'profile-nick', text: nickOf(other) })),
      section('Код безопасности', codeBox,
        h('p', { text: 'Сравните с кодом на телефоне друга — при встрече или по звонку. Совпадает — значит, переписку никто не подменяет.' })));
    return;
  }

  await loadPubKeys(c.member_ids || []);
  const title = h('input', { value: c.title || '', maxLength: 60 });
  const add = h('input', { placeholder: 'Ник', autocapitalize: 'off', spellcheck: 'false' });
  const msg = note();
  const members = (c.member_ids || []).map((uid) => h('div', { class: 'member' }, userAvatar(uid, 'xs'),
    h('div', { class: 'row-text' },
      h('b', { text: nameOf(uid) + (uid === state.me.id ? ' (вы)' : '') }),
      h('small', { text: nickOf(uid) + (keys.pub.get(uid)?.fp ? '' : ' · ещё не включил шифрование') }))));

  openModal({ title: 'Группа' },
    h('div', { class: 'profile-head' }, chatAvatar(c, 'lg')),
    section('Название', h('div', { class: 'inline' }, title, h('button', { class: 'btn', text: 'Сохранить', onclick: async () => {
      const { error } = await sb.rpc('rename_group', { conv: id, new_title: title.value });
      if (error) return say(msg, humanError(error));
      await loadChats(); renderHeader(); say(msg, 'Название сохранено', 'ok');
    } }))),
    section(`Участники · ${members.length}`, ...members,
      h('div', { class: 'inline' }, add, h('button', { class: 'btn', title: 'Добавить', onclick: async () => {
        const list = parseNicks(add.value);
        if (!list.length) return;
        const missing = await missingNicks(list);
        const { error } = await sb.rpc('add_group_members', { conv: id, usernames: list });
        if (error) return say(msg, humanError(error));
        await loadChats(); renderHeader();
        await shareChatKey(id).catch(() => {});
        await openChatInfo(id);
        if (missing.length) inlineError('Не нашли: ' + missing.map((n) => '@' + n).join(', '));
      } }, icon('plus')))),
    msg,
    h('button', { class: 'btn btn-danger btn-block', text: 'Выйти из группы', onclick: async () => {
      if (!confirm(`Выйти из группы «${c.title || ''}»?`)) return;
      const { error } = await sb.from('conversation_members').delete().eq('conversation_id', id).eq('user_id', state.me.id);
      if (error) return say(msg, humanError(error));
      closeModal();
      state.chats.delete(id); state.history.delete(id); keys.chat.delete(id);
      state.activeId = null;
      document.body.classList.remove('in-chat');
      showPlaceholder(); renderChats();
    } }));
}

/* =====================================================================
   Настройки
   ===================================================================== */
$('settingsBtn').onclick = openSettings;
$('meBtn').onclick = openSettings;

function openSettings() {
  const p = state.people.get(state.me.id);
  let hue = p.avatar_hue ?? hueOf(p.username);
  const msg = note();
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  // Профиль
  const avatarSlot = h('span');
  const name = h('input', { value: p.display_name || '', maxLength: 40, placeholder: 'Имя, которое видят друзья' });
  const drawAvatar = () => avatarSlot.replaceChildren(avatar(name.value.trim() || p.username, hue, 'lg'));
  const swatches = h('div', { class: 'swatches' });
  const drawSwatches = () => swatches.replaceChildren(...HUES.map((hh) => h('button', {
    class: 'swatch' + (hh === hue ? ' on' : ''), vars: { '--h': hh }, title: 'Цвет',
    onclick: () => { hue = hh; drawSwatches(); drawAvatar(); },
  })));
  name.oninput = drawAvatar;
  drawAvatar(); drawSwatches();

  // Приложение
  let appBlock;
  if (standalone) appBlock = h('p', { text: 'Приложение установлено.' });
  else if (installPrompt) appBlock = h('button', { class: 'btn btn-primary btn-block', text: 'Установить приложение', onclick: async () => {
    installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; openSettings();
  } });
  else if (isIOS) appBlock = h('p', { text: 'На iPhone: «Поделиться» → «На экран Домой». Push-уведомления на iPhone работают только в установленном приложении.' });
  else appBlock = h('p', { text: 'В Chrome или Edge: значок установки справа в адресной строке. На Android: меню ⋮ → «Установить приложение».' });

  // Уведомления
  const pushOn = prefs.notify && 'Notification' in window && Notification.permission === 'granted';
  const pushToggle = toggle(pushOn, async (e) => {
    const want = e.target.checked;
    try {
      await setupPush(want);
      prefs.notify = want; savePrefs();
      say(msg, want ? 'Push-уведомления включены' : 'Push-уведомления выключены', 'ok');
    } catch (err) { e.target.checked = !want; say(msg, humanError(err)); }
  });

  // Шифрование
  const oldCode = h('input', { type: 'password', placeholder: 'Текущий код', autocomplete: 'off' });
  const newCode = h('input', { type: 'password', placeholder: 'Новый код', autocomplete: 'new-password' });
  const codeBtn = h('button', { class: 'btn', text: 'Сменить' });
  codeBtn.onclick = async () => {
    if (newCode.value.length < 8) return say(msg, 'Новый код должен быть от 8 символов');
    codeBtn.disabled = true;
    say(msg, 'Проверяю код…', 'ok');
    try {
      const { data: b, error } = await sb.from('key_backups').select('backup').eq('user_id', state.me.id).single();
      if (error) throw error;
      let jwk;
      try { jwk = await E2E.openBackup(b.backup, oldCode.value); } catch { throw new Error('Текущий код неверный'); }
      const backup = await E2E.sealBackup(jwk, newCode.value);
      const r = await sb.from('key_backups').update({ backup, updated_at: new Date().toISOString() }).eq('user_id', state.me.id);
      if (r.error) throw r.error;
      oldCode.value = ''; newCode.value = '';
      say(msg, 'Секретный код изменён', 'ok');
    } catch (err) { say(msg, humanError(err)); }
    codeBtn.disabled = false;
  };

  // Аккаунт
  const pass = h('input', { type: 'password', placeholder: 'Новый пароль', autocomplete: 'new-password' });

  openModal({ title: 'Настройки' },
    h('div', { class: 'profile-head' }, avatarSlot, h('div', { class: 'profile-nick', text: '@' + p.username })),
    section('Профиль', name, swatches, h('button', { class: 'btn btn-primary btn-block', text: 'Сохранить', onclick: async () => {
      const display_name = name.value.trim() || null;
      const { error } = await sb.from('profiles').update({ display_name, avatar_hue: hue }).eq('id', state.me.id);
      if (error) return say(msg, humanError(error));
      Object.assign(p, { display_name, avatar_hue: hue });
      renderMe(); renderChats();
      if (state.activeId) { renderHeader(); renderMessages(); }
      say(msg, 'Профиль сохранён', 'ok');
    } })),
    section('Оформление',
      segmented([['classic', 'Обычный'], ['dot', 'Dot']], prefs.style, (v) => { prefs.style = v; savePrefs(); applyTheme(); }),
      segmented([['light', 'Светлая'], ['dark', 'Тёмная'], ['auto', 'Авто']], prefs.mode, (v) => { prefs.mode = v; savePrefs(); applyTheme(); })),
    section('Уведомления',
      h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('b', { text: 'Push-уведомления' }), h('small', { text: 'Приходят, даже когда приложение закрыто' })), pushToggle),
      h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('b', { text: 'Звук' }), h('small', { text: 'Когда приложение открыто' })),
        toggle(prefs.sound, (e) => { prefs.sound = e.target.checked; savePrefs(); if (prefs.sound) ding(); }))),
    section('Приложение', appBlock),
    section('Шифрование',
      h('div', { class: 'row-text' }, h('small', { text: 'Ключ этого устройства' }),
        h('span', { class: 'fp', text: (keys.fp || '').slice(0, 24).replace(/(.{4})/g, '$1 ').trim() })),
      oldCode, h('div', { class: 'inline' }, newCode, codeBtn)),
    section('Аккаунт',
      h('div', { class: 'row-text' }, h('small', { text: 'Email' }), h('b', { text: state.me.email || '' })),
      h('div', { class: 'inline' }, pass, h('button', { class: 'btn', text: 'Сменить', onclick: async () => {
        if (pass.value.length < 6) return say(msg, 'Пароль должен быть от 6 символов');
        const { error } = await sb.auth.updateUser({ password: pass.value });
        if (error) return say(msg, humanError(error));
        pass.value = '';
        say(msg, 'Пароль изменён', 'ok');
      } }))),
    msg,
    h('button', { class: 'btn btn-danger btn-block', text: 'Выйти из аккаунта', onclick: async () => {
      await setupPush(false).catch(() => {});
      await E2E.store.del('me:' + state.me.id).catch(() => {});   // на этом устройстве при следующем входе понадобится код
      await sb.auth.signOut();
    } }));
}

/* =====================================================================
   Старт
   ===================================================================== */
const { data: { session } } = await sb.auth.getSession();
if (!session) $('auth').hidden = false;
