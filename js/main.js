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
  blocked: new Set(),       // кого я заблокировал
  reads: new Map(),         // id участника -> last_read_at (для открытого чата)
  showArchive: false,
  compose: null,            // { mode: 'reply' | 'edit', msg }
  typing: { channel: null, until: 0, sentAt: 0, timer: null },
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
  closeMenu();
  if ($('modalRoot').children.length) { if (!modalLocked) closeModal(); }
  else if (state.compose) setCompose(null);
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
  const { data } = await sb.from('profiles').select('id, username, display_name, avatar_hue, role').in('id', missing);
  for (const p of data || []) state.people.set(p.id, p);
}
const nameOf = (id) => { const p = state.people.get(id); return p ? (p.display_name || p.username) : '…'; };
const nickOf = (id) => '@' + (state.people.get(id)?.username || '');
const hueOfUser = (id) => { const p = state.people.get(id) || {}; return p.avatar_hue ?? hueOf(p.username); };

function avatar(label, hue, size = '', badge = null, extra = '') {
  return h('span', { class: ['avatar', size, extra].filter(Boolean).join(' '), vars: { '--h': hue } }, (label || '?')[0].toUpperCase(),
    badge ? h('span', { class: 'badge' }, icon(badge)) : null);
}
const roleOf = (id) => state.people.get(id)?.role || null;
const ROLE_LABEL = { creator: 'Создатель', tester: 'Тестер' };
function roleBadge(id) {
  const r = roleOf(id);
  return r ? h('span', { class: 'role ' + r, title: r === 'creator' ? 'Создатель мессенджера' : 'Тестер мессенджера', text: ROLE_LABEL[r] }) : null;
}
/** Имя + значок роли (или галочка официального чата) с обрезкой длинного текста */
const nameLine = (text, ...after) => h('span', { class: 'name-line' }, h('span', { class: 't', text }), ...after);
const userAvatar = (id, size) => avatar(nameOf(id), hueOfUser(id), size, null, roleOf(id));
const isStaffMe = () => !!roleOf(state.me.id);
const otherOf = (c) => (c.member_ids || []).find((id) => id !== state.me.id);
const titleOf = (c) => (c.is_group ? c.title || 'Группа' : nameOf(otherOf(c)));
const chatAvatar = (c, size) => (c.is_group ? avatar(c.title, hueOf(c.title), size, c.is_official ? 'verified' : 'users') : userAvatar(otherOf(c), size));
function verifiedIcon() { const v = icon('verified'); v.setAttribute('class', 'i verified'); return v; }
const chatBadge = (c) => (c.is_official ? verifiedIcon() : c.is_group ? null : roleBadge(otherOf(c)));
/** Почему нельзя писать в чат (или null, если можно) */
function writeBlock(c) {
  if (c.is_official && !isStaffMe()) return { text: 'Писать в официальный чат может только команда' };
  if (!c.is_group && state.blocked.has(otherOf(c))) return { text: `Вы заблокировали ${nameOf(otherOf(c))}`, unblock: otherOf(c) };
  return null;
}

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
  await loadBlocks();
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
  state.people.clear(); state.chats.clear(); state.history.clear(); state.blocked.clear(); state.reads.clear();
  state.showArchive = false;
  setCompose(null);
  leaveTyping();
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

async function loadBlocks() {
  const { data } = await sb.from('blocks').select('blocked').eq('blocker', state.me.id);
  state.blocked = new Set((data || []).map((r) => r.blocked));
}

function renderMe() {
  const p = state.people.get(state.me.id);
  $('meName').replaceChildren(nameLine(p.display_name || p.username, roleBadge(state.me.id)));
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
  if (!c.last_sender) return c.is_group ? (c.is_official ? 'Официальный чат' : 'Группа создана') : 'Новый чат';
  if (state.blocked.has(c.last_sender)) return 'Сообщение скрыто';
  const who = c.last_sender === state.me.id ? 'Вы: ' : c.is_group ? nameOf(c.last_sender) + ': ' : '';
  return who + previewText(c.last_p);
}

function renderChats() {
  const all = [...state.chats.values()].sort((a, b) =>
    (b.is_official - a.is_official) || ts(b.last_message_at) - ts(a.last_message_at));
  const archived = all.filter((c) => c.archived);
  if (state.showArchive && !archived.length) state.showArchive = false;
  const items = all.filter((c) => !!c.archived === state.showArchive);
  const unread = all.filter((c) => !c.archived && isUnread(c)).length;
  $('listLabel').textContent = state.showArchive ? 'Архив' : 'Чаты';
  document.title = unread ? `(${unread}) Мессенджер` : 'Мессенджер';
  if ('setAppBadge' in navigator) (unread ? navigator.setAppBadge(unread) : navigator.clearAppBadge()).catch(() => {});

  const head = [];
  if (state.showArchive) {
    head.push(h('button', { class: 'archive-row', onclick: () => { state.showArchive = false; renderChats(); } },
      h('span', { class: 'avatar sm' }, icon('back')), 'Назад к чатам'));
  } else if (archived.length) {
    const archivedUnread = archived.filter(isUnread).length;
    head.push(h('button', { class: 'archive-row', onclick: () => { state.showArchive = true; renderChats(); } },
      h('span', { class: 'avatar sm' }, icon('archive')), 'Архив',
      h('span', { class: 'count', text: archivedUnread ? `${archived.length} · ${archivedUnread} новых` : String(archived.length) })));
  }
  if (!items.length) {
    $('chatList').replaceChildren(...head, h('div', { class: 'list-empty', text: 'Чатов пока нет. Найдите друга по нику или создайте группу.' }));
    return;
  }
  $('chatList').replaceChildren(...head, ...items.map((c) => {
    const un = isUnread(c) && c.id !== state.activeId;
    return h('button', {
      class: 'chat-item' + (c.id === state.activeId ? ' active' : '') + (un ? ' unread' : ''),
      onclick: () => openChat(c.id),
    },
      chatAvatar(c),
      h('span', { class: 'chat-item-body' },
        h('span', { class: 'chat-item-row' },
          h('span', { class: 'chat-item-name' }, nameLine(titleOf(c), chatBadge(c))),
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
  const { data, error } = await sb.from('profiles').select('id, username, display_name, avatar_hue, role').eq('username', q).maybeSingle();
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
const MSG_COLUMNS = 'id, conversation_id, sender_id, ct, iv, created_at, edited_at';

function showPlaceholder() {
  leaveTyping();
  setCompose(null);
  $('placeholder').hidden = false;
  $('messages').hidden = true;
  $('composer').hidden = true;
  $('lockedBar').hidden = true;
  $('composeBar').hidden = true;
  $('uploading').hidden = true;
  $('chatTitle').textContent = '';
  $('chatStatus').replaceChildren();
  $('chatAvatar').replaceChildren();
}

function renderHeader() {
  const c = state.chats.get(state.activeId);
  if (!c) return;
  $('chatTitle').replaceChildren(nameLine(titleOf(c), chatBadge(c)));
  $('chatAvatar').replaceChildren(chatAvatar(c, 'sm'));
  if (Date.now() < state.typing.until) {
    $('chatStatus').replaceChildren(h('span', { class: 'typing', text: c.is_group ? `${nameOf(state.typing.who)} печатает…` : 'печатает…' }));
    return;
  }
  const n = (c.member_ids || []).length;
  const members = `${n} ${plural(n, 'участник', 'участника', 'участников')}`;
  $('chatStatus').replaceChildren(icon('lock'),
    c.is_group ? (c.is_official ? 'Официальный чат · ' + members : members) : nickOf(otherOf(c)));
}

function renderComposer() {
  const c = state.chats.get(state.activeId);
  const block = c && writeBlock(c);
  $('composer').hidden = !c || !!block;
  $('composeBar').hidden = !c || !!block || !state.compose;
  $('lockedBar').hidden = !block;
  if (block) {
    $('lockedBar').replaceChildren(h('span', { text: block.text }),
      block.unblock ? h('button', { class: 'btn', text: 'Разблокировать', onclick: () => setBlocked(block.unblock, false) }) : null);
  }
}

/* ---------- «печатает…» (через Realtime Broadcast, в базу не пишется) ---------- */
function joinTyping(chatId) {
  leaveTyping();
  state.typing.channel = sb.channel('typing:' + chatId)
    .on('broadcast', { event: 'typing' }, ({ payload }) => {
      if (!payload || payload.user === state.me?.id || state.activeId !== chatId || state.blocked.has(payload.user)) return;
      state.typing.until = Date.now() + 3500;
      state.typing.who = payload.user;
      renderHeader();
      clearTimeout(state.typing.timer);
      state.typing.timer = setTimeout(renderHeader, 3600);
    })
    .subscribe();
}
function leaveTyping() {
  if (state.typing.channel) sb.removeChannel(state.typing.channel);
  state.typing.channel = null;
  state.typing.until = 0;
}
function sendTyping() {
  if (!state.typing.channel || Date.now() - state.typing.sentAt < 2000) return;
  state.typing.sentAt = Date.now();
  state.typing.channel.send({ type: 'broadcast', event: 'typing', payload: { user: state.me.id } }).catch?.(() => {});
}

async function loadReads(chatId) {
  const { data } = await sb.from('conversation_members').select('user_id, last_read_at').eq('conversation_id', chatId);
  state.reads = new Map((data || []).map((r) => [r.user_id, r.last_read_at]));
}

async function openChat(id) {
  if (!state.chats.has(id)) await loadChats();
  if (!state.chats.has(id)) return;
  if (state.activeId !== id) setCompose(null);
  state.activeId = id;
  document.body.classList.add('in-chat');
  $('placeholder').hidden = true;
  $('messages').hidden = false;
  renderHeader();
  renderComposer();
  markRead(id);
  renderChats();
  joinTyping(id);
  loadReads(id).then(() => { if (state.activeId === id && state.history.has(id)) renderMessages(); });

  if (!state.history.has(id)) {
    $('messages').replaceChildren(h('div', { class: 'day', text: 'Загрузка…' }));
    const { data, error } = await sb.from('messages').select(MSG_COLUMNS)
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
  if (!mine && state.blocked.has(m.sender_id)) {
    return h('div', { class: 'msg hidden-msg', dataset: { id: m.id } }, 'Сообщение от заблокированного пользователя');
  }
  const classes = ['msg', mine && 'mine', p?.img && 'photo', (!p || p.bad) && 'locked', continued && 'cont'];
  const el = h('div', { class: classes.filter(Boolean).join(' '), dataset: { id: m.id } });
  if (showName) {
    el.append(h('div', { class: 'msg-from', vars: { '--h': hueOfUser(m.sender_id) } }, nameLine(nameOf(m.sender_id), roleBadge(m.sender_id))));
  }
  if (p?.r) {
    el.append(h('button', { class: 'msg-quote', type: 'button', onclick: () => jumpTo(p.r.id) },
      h('b', { text: nameOf(p.r.s) }), h('span', { text: p.r.t || 'Фото' })));
  }
  if (p?.img) {
    const img = h('img', { class: 'msg-img', alt: 'Фото', dataset: { path: p.img.path, iv: p.img.iv, mime: p.img.mime || 'image/jpeg', chat: m.conversation_id } });
    if (p.img.w && p.img.h) img.style.aspectRatio = `${p.img.w} / ${p.img.h}`;
    img.onclick = () => img.src && openLightbox(img.src);
    el.append(img);
  }
  const text = !p ? 'Сообщение ещё не расшифровано' : p.bad ? 'Не удалось расшифровать' : p.t;
  if (text) el.append(h('div', { class: 'msg-text', text }));

  const meta = h('span', { class: 'msg-meta' });
  if (m.edited_at) meta.append(h('span', { text: 'изменено' }));
  meta.append(h('span', { class: 'time', text: timeOf(m.created_at) }));
  if (mine) {
    const read = isReadByOthers(m);
    meta.append(h('span', { class: 'ticks' + (read ? ' read' : ''), title: read ? 'Прочитано' : 'Отправлено', text: read ? '✓✓' : '✓' }));
  }
  el.append(meta);
  attachMenu(el, m);
  return el;
}

/** Прочитано ли моё сообщение: в личном чате — собеседником, в группе — хотя бы одним участником */
function isReadByOthers(m) {
  for (const [uid, at] of state.reads) if (uid !== state.me.id && ts(at) >= ts(m.created_at)) return true;
  return false;
}

function jumpTo(id) {
  const el = $('messages').querySelector(`[data-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

/* ---------- Меню сообщения: правый клик или долгое нажатие ---------- */
function attachMenu(el, m) {
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(m, e.clientX, e.clientY); });
  let timer = null;
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    timer = setTimeout(() => { timer = null; navigator.vibrate?.(10); openMenu(m, t.clientX, t.clientY); }, 450);
  }, { passive: true });
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchmove', cancel, { passive: true });
}

function closeMenu() { document.querySelector('.menu')?.remove(); }
function openMenu(m, x, y) {
  closeMenu();
  if (!m.p || m.p.bad) return;
  const mine = m.sender_id === state.me.id;
  const c = state.chats.get(m.conversation_id);
  const items = [];
  if (c && !writeBlock(c)) items.push(['reply', 'Ответить', () => setCompose({ mode: 'reply', msg: m })]);
  if (m.p.t) items.push(['copy', 'Копировать', () => navigator.clipboard?.writeText(m.p.t)]);
  if (mine && !m.p.img && c && !writeBlock(c)) items.push(['edit', 'Изменить', () => setCompose({ mode: 'edit', msg: m })]);
  if (mine) items.push(['trash', 'Удалить у всех', () => deleteMessage(m), 'danger']);
  if (!items.length) return;
  const menu = h('div', { class: 'menu', role: 'menu' }, ...items.map(([ic, label, fn, cls]) =>
    h('button', { class: cls || '', role: 'menuitem', onclick: () => { closeMenu(); fn(); } }, icon(ic), label)));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) closeMenu(); });
addEventListener('resize', closeMenu);
document.addEventListener('scroll', closeMenu, true);

async function deleteMessage(m) {
  if (!confirm('Удалить сообщение у всех?')) return;
  const { error } = await sb.from('messages').delete().eq('id', m.id);
  if (error) return inlineError('Не удалилось: ' + humanError(error));
  removeMessage(m.id);
}

function removeMessage(id) {
  for (const [chatId, list] of state.history) {
    const i = list.findIndex((x) => x.id === id);
    if (i === -1) continue;
    list.splice(i, 1);
    const c = state.chats.get(chatId);
    if (c) {
      const lastMsg = list[list.length - 1];
      Object.assign(c, lastMsg
        ? { last_ct: lastMsg.ct, last_iv: lastMsg.iv, last_p: lastMsg.p, last_sender: lastMsg.sender_id }
        : { last_ct: null, last_iv: null, last_p: null, last_sender: null });
    }
    if (chatId === state.activeId) renderMessages();
    renderChats();
    return;
  }
  loadChats();   // сообщения не было в открытой истории — просто обновим список
}

/* ---------- Ответ / изменение ---------- */
function setCompose(next) {
  const wasEdit = state.compose?.mode === 'edit';
  state.compose = next;
  if (!next) {
    $('composeBar').hidden = true;
    if (wasEdit) { textArea.value = ''; autosize(); }
    return;
  }
  const p = next.msg.p;
  setIcon($('composeBar'), next.mode === 'edit' ? 'edit' : 'reply');
  $('composeTitle').textContent = next.mode === 'edit' ? 'Изменение' : 'Ответ ' + nameOf(next.msg.sender_id);
  $('composeText').textContent = p.t || 'Фото';
  $('composeBar').hidden = false;
  if (next.mode === 'edit') { textArea.value = p.t || ''; autosize(); }
  textArea.focus();
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
textArea.addEventListener('input', () => { autosize(); if (textArea.value) sendTyping(); });
$('composeCancel').onclick = () => setCompose(null);
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
    .select(MSG_COLUMNS).single();
  if (error) throw error;
  data.p = payload;
  return data;
}

/** Цитата для ответа: кто, что (коротко) и id исходного сообщения — всё внутри шифра */
function replyRef() {
  if (state.compose?.mode !== 'reply') return undefined;
  const m = state.compose.msg;
  return { id: m.id, s: m.sender_id, t: (m.p.t || (m.p.img ? 'Фото' : '')).slice(0, 120) };
}

async function editMessage(m, newText) {
  const payload = { ...m.p, t: newText };
  const { ct, iv } = await E2E.sealJson(keys.chat.get(m.conversation_id), payload, aadMsg(m.conversation_id, state.me.id));
  const { data, error } = await sb.from('messages').update({ ct, iv }).eq('id', m.id).select(MSG_COLUMNS).single();
  if (error) throw error;
  data.p = payload;
  upsertMessage(data);
}

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const content = textArea.value.trim();
  const chatId = state.activeId;
  if (!content || !chatId || !(await canSend(chatId))) return;
  const compose = state.compose;
  const payload = { t: content, r: replyRef() };
  textArea.value = '';
  autosize();
  setCompose(null);
  try {
    if (compose?.mode === 'edit') await editMessage(compose.msg, content);
    else addMessage(await insertMessage(chatId, payload));
  } catch (err) {
    textArea.value = content;
    autosize();
    if (compose) setCompose(compose);
    inlineError(sendError(err));
  }
};

function sendError(err) {
  const m = String(err?.message || err);
  if (/row-level security/i.test(m)) return 'Не отправилось: вы не можете писать в этот чат';
  return 'Не отправилось: ' + humanError(err);
}

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
    const msg = await insertMessage(chatId, { t: caption, img: { path, iv: sealed.iv, mime: type, w, h: height }, r: replyRef() });
    if (caption) { textArea.value = ''; autosize(); }
    setCompose(null);
    addMessage(msg);
  } catch (err) {
    inlineError(sendError(err).replace('Не отправилось', 'Фото не отправилось'));
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
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, async (p) => {
      if (p.new?.id) upsertMessage(await decryptMessage({ ...p.new, p: null }));
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (p) => { if (p.old?.id) removeMessage(p.old.id); })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_members' }, (p) => {
      const r = p.new;
      if (!r) return;
      if (r.conversation_id === state.activeId && r.user_id !== me) { state.reads.set(r.user_id, r.last_read_at); renderMessages(); }
      const c = state.chats.get(r.conversation_id);
      if (r.user_id === me && c && c.archived !== r.archived) { c.archived = r.archived; renderChats(); }
    })
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

/** Заменить изменённое сообщение в истории и в списке */
function upsertMessage(m) {
  const list = state.history.get(m.conversation_id);
  const i = list ? list.findIndex((x) => x.id === m.id) : -1;
  if (i !== -1) list[i] = m;
  const c = state.chats.get(m.conversation_id);
  if (c && list && list[list.length - 1]?.id === m.id) Object.assign(c, { last_ct: m.ct, last_iv: m.iv, last_p: m.p });
  if (m.conversation_id === state.activeId) renderMessages();
  renderChats();
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
  if (fromServer && isNew && m.sender_id !== state.me.id && !visible && prefs.sound && !state.blocked.has(m.sender_id)) ding();
  if (m.sender_id !== state.me.id && state.typing.who === m.sender_id) { state.typing.until = 0; renderHeader(); }
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
   Действия: архив, блокировка, удаление
   ===================================================================== */
async function setArchived(chatId, value) {
  const c = state.chats.get(chatId);
  const { error } = await sb.from('conversation_members').update({ archived: value })
    .eq('conversation_id', chatId).eq('user_id', state.me.id);
  if (error) throw error;
  if (c) c.archived = value;
  if (value && state.activeId === chatId) closeChat();
  renderChats();
}

async function setBlocked(userId, value) {
  const r = value
    ? await sb.from('blocks').insert({ blocker: state.me.id, blocked: userId })
    : await sb.from('blocks').delete().eq('blocker', state.me.id).eq('blocked', userId);
  if (r.error && !/duplicate/i.test(r.error.message)) throw r.error;
  value ? state.blocked.add(userId) : state.blocked.delete(userId);
  renderChats();
  if (state.activeId) { renderComposer(); renderMessages(); }
}

function closeChat() {
  state.activeId = null;
  document.body.classList.remove('in-chat');
  showPlaceholder();
}

function forgetChat(chatId) {
  state.chats.delete(chatId); state.history.delete(chatId); keys.chat.delete(chatId);
  if (state.activeId === chatId) closeChat();
  renderChats();
}

/** Кнопка-действие для окна: подпись, иконка, обработчик, сообщение об ошибке в msg */
const actionBtn = (label, ic, msg, fn, cls = '') => h('button', { class: 'btn btn-block ' + cls, onclick: async () => {
  try { await fn(); } catch (err) { say(msg, humanError(err)); }
} }, icon(ic), label);

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
    const msg = note();
    const blocked = state.blocked.has(other);
    openModal({ title: 'Профиль' },
      h('div', { class: 'profile-head' }, userAvatar(other, 'lg'),
        h('div', { class: 'profile-name' }, nameLine(nameOf(other), roleBadge(other))), h('div', { class: 'profile-nick', text: nickOf(other) })),
      section('Код безопасности', codeBox,
        h('p', { text: 'Сравните с кодом на телефоне друга — при встрече или по звонку. Совпадает — значит, переписку никто не подменяет.' })),
      msg,
      actionBtn(c.archived ? 'Вернуть из архива' : 'В архив', 'archive', msg, async () => { await setArchived(id, !c.archived); closeModal(); }),
      actionBtn(blocked ? 'Разблокировать' : 'Заблокировать', 'block', msg, async () => {
        if (!blocked && !confirm(`Заблокировать ${nameOf(other)}? Он не сможет вам писать и добавлять вас в группы.`)) return;
        await setBlocked(other, !blocked); openChatInfo(id);
      }),
      actionBtn('Удалить чат', 'trash', msg, async () => {
        if (!confirm(`Удалить чат с ${nameOf(other)}? Переписка удалится у вас обоих.`)) return;
        const { error } = await sb.rpc('delete_dm', { conv: id });
        if (error) throw error;
        closeModal(); forgetChat(id);
      }, 'btn-danger'));
    return;
  }

  await loadPubKeys(c.member_ids || []);
  const title = h('input', { value: c.title || '', maxLength: 60 });
  const add = h('input', { placeholder: 'Ник', autocapitalize: 'off', spellcheck: 'false' });
  const msg = note();
  const members = (c.member_ids || []).map((uid) => h('div', { class: 'member' }, userAvatar(uid, 'xs'),
    h('div', { class: 'row-text' },
      h('b', {}, nameLine(nameOf(uid) + (uid === state.me.id ? ' (вы)' : ''), roleBadge(uid))),
      h('small', { text: nickOf(uid) + (keys.pub.get(uid)?.fp ? '' : ' · ещё не включил шифрование') }))));

  const officialRow = roleOf(state.me.id) === 'creator'
    ? section('Команда', h('div', { class: 'row' },
        h('div', { class: 'row-text' }, h('b', { text: 'Официальный чат' }), h('small', { text: 'Галочка, закреплён сверху, писать может только команда' })),
        toggle(!!c.is_official, async (e) => {
          const { error } = await sb.rpc('set_official', { conv: id, value: e.target.checked });
          if (error) { e.target.checked = !e.target.checked; return say(msg, humanError(error)); }
          c.is_official = e.target.checked;
          renderChats(); renderHeader(); renderComposer();
        })))
    : null;

  openModal({ title: c.is_official ? 'Официальный чат' : 'Группа' },
    h('div', { class: 'profile-head' }, chatAvatar(c, 'lg')),
    officialRow,
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
    actionBtn(c.archived ? 'Вернуть из архива' : 'В архив', 'archive', msg, async () => { await setArchived(id, !c.archived); closeModal(); }),
    actionBtn('Выйти из группы', 'trash', msg, async () => {
      if (!confirm(`Выйти из группы «${c.title || ''}»?`)) return;
      const { error } = await sb.from('conversation_members').delete().eq('conversation_id', id).eq('user_id', state.me.id);
      if (error) throw error;
      closeModal(); forgetChat(id);
    }, 'btn-danger'));
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

  // Заблокированные
  const blockedList = h('div', { style: { display: 'grid', gap: '10px' } });
  (async () => {
    await loadPeople([...state.blocked]);
    blockedList.replaceChildren(...(state.blocked.size ? [...state.blocked].map((uid) => h('div', { class: 'member' },
      userAvatar(uid, 'xs'),
      h('div', { class: 'row-text', style: { flex: '1' } }, h('b', { text: nameOf(uid) }), h('small', { text: nickOf(uid) })),
      h('button', { class: 'btn', text: 'Разблокировать', onclick: async () => {
        try { await setBlocked(uid, false); openSettings(); } catch (err) { say(msg, humanError(err)); }
      } }))) : [h('p', { text: 'Никого нет.' })]));
  })();

  // Команда (только для создателей)
  let teamSection = null;
  if (roleOf(state.me.id) === 'creator') {
    const teamList = h('div', { style: { display: 'grid', gap: '10px' } });
    const nick = h('input', { placeholder: 'Ник тестера', autocapitalize: 'off', spellcheck: 'false' });
    const drawTeam = async () => {
      const { data } = await sb.from('profiles').select('id, username, display_name, avatar_hue, role').in('role', ['creator', 'tester']);
      for (const pp of data || []) state.people.set(pp.id, pp);
      teamList.replaceChildren(...(data || []).map((pp) => h('div', { class: 'member' },
        userAvatar(pp.id, 'xs'),
        h('div', { class: 'row-text', style: { flex: '1' } }, h('b', {}, nameLine(nameOf(pp.id), roleBadge(pp.id))), h('small', { text: nickOf(pp.id) })),
        pp.role === 'tester' ? h('button', { class: 'btn', text: 'Убрать', onclick: async () => {
          const { error } = await sb.rpc('set_role', { p_username: pp.username, p_role: null });
          if (error) return say(msg, humanError(error));
          pp.role = null; drawTeam(); renderMe(); renderChats();
        } }) : null)));
    };
    drawTeam();
    teamSection = section('Команда', teamList, h('div', { class: 'inline' }, nick, h('button', { class: 'btn', text: 'Сделать тестером', onclick: async () => {
      const u = nick.value.trim().replace(/^@/, '').toLowerCase();
      if (!u) return;
      const { error } = await sb.rpc('set_role', { p_username: u, p_role: 'tester' });
      if (error) return say(msg, /not found/i.test(error.message) ? `Не нашли @${u}` : humanError(error));
      nick.value = '';
      for (const pp of state.people.values()) if (pp.username === u) pp.role = 'tester';
      say(msg, `@${u} теперь тестер`, 'ok');
      drawTeam(); renderChats();
    } })),
      h('p', { text: 'Тестеры получают значок и могут писать в официальные чаты.' }));
  }

  openModal({ title: 'Настройки' },
    h('div', { class: 'profile-head' }, avatarSlot, roleBadge(state.me.id), h('div', { class: 'profile-nick', text: '@' + p.username })),
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
    teamSection,
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
    section('Заблокированные', blockedList),
    msg,
    h('button', { class: 'btn btn-danger btn-block', text: 'Выйти из аккаунта', onclick: signOut }),
    h('button', { class: 'btn btn-danger btn-block', text: 'Удалить аккаунт', onclick: () => deleteAccountDialog(p.username) }));
}

async function signOut() {
  await setupPush(false).catch(() => {});
  await E2E.store.del('me:' + state.me.id).catch(() => {});   // на этом устройстве при следующем входе понадобится код
  await sb.auth.signOut();
}

function deleteAccountDialog(username) {
  const confirmInput = h('input', { placeholder: username, autocapitalize: 'off', spellcheck: 'false' });
  const msg = note();
  openModal({ title: 'Удалить аккаунт' },
    h('p', { text: 'Удалятся профиль, все ваши сообщения, ключи и личные чаты. Отменить это нельзя.' }),
    h('label', { class: 'field' }, h('span', { text: `Введите свой ник «${username}», чтобы подтвердить` }), confirmInput),
    msg,
    h('button', { class: 'btn btn-danger btn-block', text: 'Удалить навсегда', onclick: async () => {
      if (confirmInput.value.trim().toLowerCase() !== username) return say(msg, 'Ник не совпадает');
      await setupPush(false).catch(() => {});
      const { error } = await sb.rpc('delete_account');
      if (error) return say(msg, humanError(error));
      await E2E.store.del('me:' + state.me.id).catch(() => {});
      await sb.auth.signOut();
    } }));
}

/* =====================================================================
   Старт
   ===================================================================== */
const { data: { session } } = await sb.auth.getSession();
if (!session) $('auth').hidden = false;
