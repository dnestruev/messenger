import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from '../config.js';
import * as E2E from './crypto.js';
import { createNet } from './net.js';
import { qrSvg } from './qr.js';
import { renderMarkdown, stripMarkdown } from './md.js';

/* =====================================================================
   Утилиты
   ===================================================================== */
const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const BUCKET = 'chat-images';
const HUES = [230, 265, 300, 340, 15, 40, 150, 185];
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** Версия iOS: [15, 8] (null — не iPhone или не определили) */
const iosVersion = (() => { const m = navigator.userAgent.match(/OS (\d+)_(\d+)/); return isIOS && m ? [+m[1], +m[2]] : null; })();
const uuid = () => crypto.randomUUID ? crypto.randomUUID()
  : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

/* Высота экрана. На iPhone клавиатура и панели Safari не уменьшают 100vh, из-за этого всё «едет».
   Берём реальную видимую высоту и не даём Safari прокручивать страницу целиком. */
(function fitViewport() {
  const vv = window.visualViewport;
  const fit = () => {
    const m = $('messages');
    const atBottom = m && m.scrollHeight - m.scrollTop - m.clientHeight < 120;   // клавиатура не должна прятать последние сообщения
    if (atBottom) requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
    document.documentElement.style.setProperty('--app-h', Math.round(vv ? vv.height : window.innerHeight) + 'px');
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  };
  fit();
  (vv || window).addEventListener('resize', fit);
  if (vv) vv.addEventListener('scroll', fit);
  window.addEventListener('orientationchange', () => setTimeout(fit, 350));
})();

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
    [/group limit reached/i, 'Достигнут лимит групп. С Плюсом можно до 100 групп'],
    [/group is full/i, 'Группа заполнена. С Плюсом у создателя группы — до 500 человек'],
    [/frame needs plus/i, 'Рамки доступны только с Плюсом'],
    [/only partners can gift/i, 'Дарить Плюс могут только партнёры с работающим узлом'],
    [/gift limit reached/i, 'Можно подарить Плюс только 5 друзьям'],
    [/cannot gift yourself/i, 'Себе подарить нельзя'],
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
const net = createNet(sb);

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
  more: new Map(),          // id чата -> есть ли более ранние сообщения
  typing: { channel: null, until: 0, sentAt: 0, timer: null },
  perks: new Map(),         // id -> 'partner' | 'plus' (награды за узел-партнёр)
  seen: new Map(),          // chatId -> Set: какие сообщения уже показаны (новые появляются с анимацией)
};
const keys = {
  priv: null,               // мой секретный ключ (неизвлекаемый)
  fp: null,                 // отпечаток моего публичного ключа
  chat: new Map(),          // '<id чата>:<версия>' -> ключ AES-GCM
  pub: new Map(),           // id пользователя -> { jwk, fp }
  trusted: {},              // id пользователя -> отпечаток, которому доверяем (на этом устройстве)
  sign: null,               // мой ключ подписи (неизвлекаемый)
  verify: new Map(),        // id пользователя -> ключ проверки подписи
};

/* =====================================================================
   Оформление и настройки устройства
   ===================================================================== */
const prefs = { style: 'classic', mode: 'auto', sound: true, notify: false, accent: null, plus: false };
try {
  const saved = JSON.parse(localStorage.getItem('prefs') || '{}');
  if (saved.theme && !saved.mode) saved.mode = saved.theme;   // старый формат
  Object.assign(prefs, saved);
} catch {}
const savePrefs = () => { try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch {} };
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const resolvedMode = () => (prefs.mode === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : prefs.mode);

const PLUS_STYLES = ['paper', 'neon'];
function applyTheme() {
  const root = document.documentElement;
  const plus = prefs.plus;                                  // запоминаем, чтобы тема не мигала при запуске
  root.dataset.style = !plus && PLUS_STYLES.includes(prefs.style) ? 'classic' : prefs.style;
  root.dataset.mode = resolvedMode();
  if (plus && prefs.accent != null) {
    const dark = resolvedMode() === 'dark';
    root.style.setProperty('--accent', `hsl(${prefs.accent} 72% ${dark ? 60 : 50}%)`);
    root.style.setProperty('--accent-soft', `hsl(${prefs.accent} ${dark ? '35% 18%' : '85% 94%'})`);
  } else { root.style.removeProperty('--accent'); root.style.removeProperty('--accent-soft'); }
  setIcon($('modeBtn'), resolvedMode() === 'dark' ? 'sun' : 'moon');
  const bg = getComputedStyle(root).getPropertyValue('--surface').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#ffffff');
}
darkQuery.addEventListener('change', () => { if (prefs.mode === 'auto') applyTheme(); });
applyTheme();
/** Плавная смена темы: цвета перетекают, а не прыгают */
function smoothTheme(fn) {
  const root = document.documentElement;
  root.classList.add('theming');
  fn();
  clearTimeout(smoothTheme.t);
  smoothTheme.t = setTimeout(() => root.classList.remove('theming'), 450);
}
$('modeBtn').onclick = () => smoothTheme(() => { prefs.mode = resolvedMode() === 'dark' ? 'light' : 'dark'; savePrefs(); applyTheme(); });

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
let PROFILE_COLUMNS = 'id, username, display_name, avatar_hue, role, frame, avatar_path';
/** Запрос профилей; если база ещё без аватарок (update-8) — повторяем без этой колонки */
async function selectProfiles(build) {
  let r = await build(sb.from('profiles').select(PROFILE_COLUMNS));
  if (r.error && /avatar_path/.test(r.error.message || '')) {
    PROFILE_COLUMNS = PROFILE_COLUMNS.replace(', avatar_path', '');
    r = await build(sb.from('profiles').select(PROFILE_COLUMNS));
  }
  return r;
}
async function loadPeople(ids) {
  const missing = [...new Set(ids)].filter((id) => id && !state.people.has(id));
  if (!missing.length) return;
  const { data } = await selectProfiles((q) => q.in('id', missing));
  for (const p of data || []) state.people.set(p.id, p);
}
/** Освежить профили всех, кого знаем: имена, роли, рамки меняются без перезапуска. */
async function refreshPeople() {
  const ids = [...state.people.keys()];
  let changed = false;
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await selectProfiles((q) => q.in('id', ids.slice(i, i + 100)));
    for (const p of data || []) {
      const old = state.people.get(p.id);
      if (!old || ['username', 'display_name', 'avatar_hue', 'role', 'frame', 'avatar_path'].some((k) => old[k] !== p[k])) changed = true;
      state.people.set(p.id, p);
    }
  }
  return changed;
}
const nameOf = (id) => { const p = state.people.get(id); return p ? (p.display_name || p.username) : '…'; };
const nickOf = (id) => '@' + (state.people.get(id)?.username || '');
const hueOfUser = (id) => { const p = state.people.get(id) || {}; return p.avatar_hue ?? hueOf(p.username); };

const AVATAR_BUCKET = 'avatars';
const avatarUrl = (path) => (path ? `${SUPABASE_URL}/storage/v1/object/public/${AVATAR_BUCKET}/${path}` : null);
const photoOf = (id) => avatarUrl(state.people.get(id)?.avatar_path);
function avatar(label, hue, size = '', badge = null, extra = '', photo = null) {
  return h('span', { class: ['avatar', size, extra, photo && 'has-photo'].filter(Boolean).join(' '), vars: { '--h': hue } }, (label || '?')[0].toUpperCase(),
    photo ? h('img', { class: 'avatar-img', src: photo, alt: '', loading: 'lazy', decoding: 'async', draggable: false,
      onerror: (e) => { e.target.parentNode?.classList.remove('has-photo'); e.target.remove(); } }) : null,
    badge ? h('span', { class: 'badge' }, icon(badge)) : null);
}
const roleOf = (id) => state.people.get(id)?.role || null;
const ROLE_LABEL = { creator: 'Создатель', tester: 'Тестер' };
const perkOf = (id) => state.perks.get(id) || null;
const hasPlus = (id = state.me?.id) => !!perkOf(id);
const PERK_LABEL = { partner: 'Партнёр', plus: 'Плюс' };
const PERK_TITLE = { partner: 'Держит узел сети: хранит зашифрованные сообщения для всех', plus: 'Плюс в подарок от партнёра сети' };
/** compact — в списке чатов и шапке: награда маленьким значком, чтобы имя не обрезалось */
function roleBadge(id, compact = false) {
  const r = roleOf(id), k = perkOf(id);
  return [
    r ? h('span', { class: 'role ' + r, title: r === 'creator' ? 'Создатель мессенджера' : 'Тестер мессенджера', text: ROLE_LABEL[r] }) : null,
    k ? h('span', { class: 'role ' + k + (compact ? ' mini' : ''), title: PERK_TITLE[k] + ` (${PERK_LABEL[k]})`, text: compact ? (k === 'partner' ? '★' : '+') : PERK_LABEL[k] }) : null,
  ];
}
/** Рамка видна, только пока у человека есть Плюс */
const frameOf = (id) => (hasPlus(id) && state.people.get(id)?.frame) || null;
async function loadPerks() {
  const { data, error } = await sb.rpc('perks_list');
  if (error) return;                                        // база ещё без update-7
  const next = new Map((data || []).map((r) => [r.user_id, r.kind]));
  let changed = next.size !== state.perks.size || [...next].some(([k, v]) => state.perks.get(k) !== v);
  state.perks = next;
  const plus = hasPlus();
  if (plus !== prefs.plus) { prefs.plus = plus; savePrefs(); applyTheme(); }
  if (await refreshPeople().catch(() => false)) changed = true;
  if (changed) { renderMe(); renderChats(); if (state.activeId) { renderHeader(); renderMessages({ keepScroll: true }); } }
  $('fileInput').multiple = plus;
}
/** Имя + значок роли (или галочка официального чата) с обрезкой длинного текста */
const nameLine = (text, ...after) => h('span', { class: 'name-line' }, h('span', { class: 't', text }), ...after);
const userAvatar = (id, size) => avatar(nameOf(id), hueOfUser(id), size, null, [roleOf(id), frameOf(id) && 'frame frame-' + frameOf(id)].filter(Boolean).join(' '), photoOf(id));
const isStaffMe = () => !!roleOf(state.me.id);
const isSaved = (c) => !!c && c.id === state.savedId;
const otherOf = (c) => (c.member_ids || []).find((id) => id !== state.me.id);
const titleOf = (c) => (isSaved(c) ? 'Избранное' : c.is_group ? c.title || 'Группа' : nameOf(otherOf(c)));
const savedAvatar = (size) => h('span', { class: ['avatar', 'saved-avatar', size].filter(Boolean).join(' ') }, icon('bookmark'));
const chatAvatar = (c, size) => (isSaved(c) ? savedAvatar(size)
  : c.is_group ? avatar(c.title, hueOf(c.title), size, c.is_official ? 'verified' : 'users') : userAvatar(otherOf(c), size));
function verifiedIcon() { const v = icon('verified'); v.setAttribute('class', 'i verified'); return v; }
const chatBadge = (c, compact = false) => (c.is_official ? verifiedIcon() : c.is_group || isSaved(c) ? null : roleBadge(otherOf(c), compact));
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
  const { data } = await sb.from('user_keys').select('user_id, public_key, fingerprint, signing_key').in('user_id', need);
  for (const r of data || []) {
    keys.pub.set(r.user_id, { jwk: r.public_key, fp: r.fingerprint });
    if (r.signing_key) keys.verify.set(r.user_id, await E2E.importVerify(r.signing_key).catch(() => null));
    else keys.verify.delete(r.user_id);
  }
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
  await ensureSigning();
}

/** Ключ подписи: берём с устройства, открываем с сервера (через мой ключ ECDH) или создаём новый. */
async function ensureSigning() {
  const id = state.me.id;
  const local = await E2E.store.get('me:' + id).catch(() => null);
  if (local?.sign && local.fp === keys.fp) { keys.sign = local.sign; return; }
  const [{ data: kb }, { data: uk }] = await Promise.all([
    sb.from('key_backups').select('signing_wrapped').eq('user_id', id).maybeSingle(),
    sb.from('user_keys').select('public_key, signing_key').eq('user_id', id).maybeSingle(),
  ]);
  if (!uk) return;
  if (kb?.signing_wrapped && uk.signing_key) {
    keys.sign = await E2E.unwrapSigning(kb.signing_wrapped, keys.priv, uk.public_key).catch(() => null);
  }
  if (!keys.sign) {
    const s = await E2E.generateSigning();
    const wrapped = await E2E.wrapSigning(s.privateJwk, keys.priv, uk.public_key);
    const r1 = await sb.from('key_backups').update({ signing_wrapped: wrapped }).eq('user_id', id);
    const r2 = await sb.from('user_keys').update({ signing_key: s.publicJwk }).eq('user_id', id);
    if (r1.error || r2.error) return;               // база ещё не обновлена — работаем без подписи
    keys.sign = await E2E.importSigning(s.privateJwk);
  }
  await E2E.store.set('me:' + id, { priv: keys.priv, fp: keys.fp, sign: keys.sign });
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

const kid = (chatId, v) => chatId + ':' + (v || 1);
const chatKey = (chatId, v) => keys.chat.get(kid(chatId, v));
const currentVersion = (chatId) => state.chats.get(chatId)?.key_version || 1;
const hasCurrentKey = (chatId) => !!chatKey(chatId, currentVersion(chatId));
const versionsHeld = (chatId) => [...keys.chat.keys()].filter((k) => k.startsWith(chatId + ':')).map((k) => +k.split(':')[1]);

/** Развернуть ключ и сверить с отпечатком в чате. Чужой или испорченный ключ — удаляем, его выдадут заново. */
async function acceptChatKey(row, checks) {
  let key;
  try { key = await E2E.unwrapChatKey(row.wrapped, keys.priv); } catch { key = null; }
  const expected = checks?.[String(row.version || 1)];
  if (key && expected && (await E2E.chatKeyCheck(key)) !== expected) key = null;
  if (!key) {
    await sb.from('conversation_keys').delete()
      .eq('conversation_id', row.conversation_id).eq('user_id', state.me.id).eq('version', row.version || 1);
    return null;
  }
  keys.chat.set(kid(row.conversation_id, row.version), key);
  return key;
}

async function loadChecks(chatIds) {
  const need = [...new Set(chatIds)];
  if (!need.length) return new Map();
  const { data } = await sb.from('conversations').select('id, key_checks').in('id', need);
  return new Map((data || []).map((r) => [r.id, r.key_checks || {}]));
}

async function loadChatKeys() {
  const { data } = await sb.from('conversation_keys').select('conversation_id, version, for_fingerprint, wrapped').eq('user_id', state.me.id);
  const rows = (data || []).filter((r) => r.for_fingerprint === keys.fp && !keys.chat.has(kid(r.conversation_id, r.version)));
  const checks = await loadChecks(rows.map((r) => r.conversation_id));
  const got = new Set();
  for (const r of rows) if (await acceptChatKey(r, checks.get(r.conversation_id))) got.add(r.conversation_id);
  return [...got];
}

/** true — есть ключ текущей версии (получен или только что создан). */
async function ensureChatKey(chatId) {
  const v = currentVersion(chatId);
  if (chatKey(chatId, v)) return true;
  const { data: r } = await sb.from('conversation_keys').select('conversation_id, version, for_fingerprint, wrapped')
    .eq('conversation_id', chatId).eq('user_id', state.me.id).eq('version', v).maybeSingle();
  if (r) {
    if (r.for_fingerprint !== keys.fp) return false;              // выдан для моего старого ключа — ждём друзей
    const checks = (await loadChecks([chatId])).get(chatId);
    return !!(await acceptChatKey(r, checks));
  }
  const key = await E2E.newChatKey();
  const { data: won, error } = await sb.rpc('claim_conversation_key', { conv: chatId, p_check: await E2E.chatKeyCheck(key) });
  if (error || !won) return false;
  keys.chat.set(kid(chatId, v), key);
  const c = state.chats.get(chatId);
  if (c) c.key_checks = { ...(c.key_checks || {}), [v]: await E2E.chatKeyCheck(key) };
  await shareChatKey(chatId);
  return true;
}

/** Отдать ключи чата (все версии, что есть у меня) участникам, у которых их нет.
    Сменившиеся ключи людей — только после подтверждения. Бывшим участникам база выдать не даст. */
async function shareChatKey(chatId) {
  const c = state.chats.get(chatId);
  const versions = versionsHeld(chatId);
  if (!c || !versions.length) return;
  // список участников берём свежий: в группу могли добавить людей с другого устройства
  const { data: mem } = await sb.from('conversation_members').select('user_id').eq('conversation_id', chatId);
  const members = mem?.length ? mem.map((r) => r.user_id) : (c.member_ids || []);
  c.member_ids = members;
  await loadPubKeys(members);
  const { data: rows } = await sb.from('conversation_keys').select('user_id, version, for_fingerprint').eq('conversation_id', chatId);
  const have = new Map((rows || []).map((r) => [r.user_id + ':' + r.version, r.for_fingerprint]));
  const out = [], warn = [];
  let trustedChanged = false;
  for (const uid of members) {
    const pk = keys.pub.get(uid);
    if (!pk?.jwk) continue;                                           // ещё не включил шифрование
    if (uid !== state.me.id) {
      if (!keys.trusted[uid]) { keys.trusted[uid] = pk.fp; trustedChanged = true; }
      if (keys.trusted[uid] !== pk.fp) { warn.push(uid); continue; }
    }
    for (const v of versions) {
      if (have.get(uid + ':' + v) === pk.fp) continue;
      out.push({ conversation_id: chatId, user_id: uid, version: v, for_fingerprint: pk.fp,
        wrapped: await E2E.wrapChatKey(chatKey(chatId, v), pk.jwk) });
    }
  }
  if (trustedChanged) await saveTrusted();
  for (const row of out) {                       // по одной: если одна запись не пройдёт проверку базы, остальные всё равно выдадутся
    await sb.from('conversation_keys').upsert(row, { onConflict: 'conversation_id,user_id,version' });
  }
  const changed = (c.keyWarn || []).join() !== warn.join();
  c.keyWarn = warn;
  if (changed && chatId === state.activeId) renderMessages();
}

async function shareAllChatKeys() {
  const chats = new Set([...keys.chat.keys()].map((k) => k.split(':')[0]));
  for (const id of chats) if (state.chats.has(id)) await shareChatKey(id).catch(() => {});
}

const sigText = (m) => `msg-v1|${m.conversation_id}|${m.sender_id}|${m.cid}|${m.ct_hash}|${m.iv}`;

/** Расшифровать сообщение: шифр берём из центра или с узлов (с проверкой хеша), затем проверяем подпись. */
async function decryptMessage(m) {
  if (m.p && !m.p.bad && !m.p.missing) return m;
  const key = chatKey(m.conversation_id, m.key_version);
  if (!key) { m.p = null; return m; }
  let ct = m.ct;
  if (!ct && m.ct_hash && m.nodes?.length) {
    const bytes = await net.get(m.nodes, `${m.conversation_id}/${m.ct_hash}`, m.ct_hash);
    if (!bytes) { m.p = { missing: true }; return m; }
    ct = E2E.b64.enc(bytes);
  }
  m.p = await E2E.openJson(key, ct, m.iv, aadMsg(m.conversation_id, m.sender_id));
  m.sigOk = await checkSignature(m);
  return m;
}

/** true — подпись верна, false — подделка, null — подписи нет (старое сообщение) или ключ неизвестен. */
async function checkSignature(m) {
  if (!m.sig || !m.cid || !m.ct_hash) return null;
  if (!keys.verify.has(m.sender_id)) await loadPubKeys([m.sender_id], true);
  const vk = keys.verify.get(m.sender_id);
  return vk ? E2E.verifyText(vk, m.sig, sigText(m)) : null;
}

/** Подготовить строку сообщения: шифр, хеш, подпись; содержимое — на узлы (если они есть) */
async function sealMessage(chatId, payload, cid = uuid()) {
  const v = currentVersion(chatId);
  const { ct, iv } = await E2E.sealJson(chatKey(chatId, v), payload, aadMsg(chatId, state.me.id));
  const bytes = E2E.b64.dec(ct);
  const ct_hash = await E2E.sha256hex(bytes);
  const nodes = await net.put(`${chatId}/${ct_hash}`, bytes).catch(() => []);
  const row = { cid, iv, ct_hash, ct: nodes.length ? null : ct, nodes: nodes.length ? nodes : null, sig: null, key_version: v };
  if (keys.sign) row.sig = await E2E.signText(keys.sign, sigText({ conversation_id: chatId, sender_id: state.me.id, ...row }));
  return row;
}

/** Последнее сообщение для списка чатов (из полей my_chats) */
const lastMessageOf = (c) => ({
  conversation_id: c.id, sender_id: c.last_sender, ct: c.last_ct, iv: c.last_iv,
  ct_hash: c.last_hash, nodes: c.last_nodes, cid: c.last_cid, sig: c.last_sig, key_version: c.last_key_version,
});
function setLast(c, m) {
  Object.assign(c, m
    ? { last_ct: m.ct, last_iv: m.iv, last_p: m.p, last_sender: m.sender_id, last_hash: m.ct_hash, last_nodes: m.nodes, last_cid: m.cid, last_sig: m.sig, last_key_version: m.key_version }
    : { last_ct: null, last_iv: null, last_p: null, last_sender: null, last_hash: null, last_nodes: null, last_cid: null, last_sig: null, last_key_version: null });
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
  await loadPerks();
  $('chatList').classList.add('list-enter');
  await loadChats();
  await ensureSaved();
  setTimeout(() => $('chatList').classList.remove('list-enter'), 600);
  clearInterval(state.perksTimer);
  state.perksTimer = setInterval(loadPerks, 2 * 60 * 1000);
  subscribe();
  shareAllChatKeys();
  if (prefs.notify && 'Notification' in window && Notification.permission === 'granted') setupPush(true).catch(() => {});

  const deep = location.hash.match(/c=([0-9a-f-]{36})/);
  if (deep) { window.history.replaceState(null, '', location.pathname); openChat(deep[1]); }
  else handleProfileLink();
}
// Вернулись в приложение (телефон разблокировали) — освежаем значки и профили
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me) loadPerks(); });

function stopApp() {
  state.me = null;
  state.activeId = null;
  state.people.clear(); state.chats.clear(); state.history.clear(); state.blocked.clear(); state.reads.clear();
  state.showArchive = false;
  clearInterval(state.perksTimer); state.perks.clear(); state.seen.clear(); state.savedId = null;
  setCompose(null);
  leaveTyping();
  for (const url of state.images.values()) URL.revokeObjectURL(url);
  state.images.clear();
  keys.priv = null; keys.fp = null; keys.chat.clear(); keys.pub.clear(); keys.trusted = {}; keys.sign = null; keys.verify.clear();
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
  $('meName').replaceChildren(nameLine(p.display_name || p.username, roleBadge(state.me.id, true)));
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
  await Promise.all(data.map(async (c) => {
    c.keyWarn = previous.get(c.id)?.keyWarn;
    const prevLast = previous.get(c.id);
    // если последнее сообщение не изменилось — не скачиваем его с узлов заново
    c.last_p = prevLast && prevLast.last_cid === c.last_cid && prevLast.last_hash === c.last_hash && prevLast.last_p && !prevLast.last_p.missing
      ? prevLast.last_p
      : c.last_sender ? (await decryptMessage(lastMessageOf(c))).p : null;
  }));
  for (const c of data) state.chats.set(c.id, c);
  await loadPeople(data.flatMap((c) => c.member_ids || []));
  renderChats();
}

function previewText(p) {
  if (!p) return 'Зашифровано';
  if (p.missing) return 'Сообщение недоступно';
  if (p.bad) return 'Не удалось расшифровать';
  const t = p.t ? stripMarkdown(p.t) : p.t;
  return p.img ? 'Фото' + (t ? ': ' + t : '') : t;
}
function previewOf(c) {
  if (!c.last_sender) return c.is_group ? (c.is_official ? 'Официальный чат' : 'Группа создана') : 'Новый чат';
  if (state.blocked.has(c.last_sender)) return 'Сообщение скрыто';
  const who = c.last_sender === state.me.id ? 'Вы: ' : c.is_group ? nameOf(c.last_sender) + ': ' : '';
  return who + previewText(c.last_p);
}

function renderChats() {
  const all = [...state.chats.values()].sort((a, b) =>
    (b.is_official - a.is_official) || (isSaved(b) - isSaved(a)) || ts(b.last_message_at) - ts(a.last_message_at));
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
          h('span', { class: 'chat-item-name' }, nameLine(titleOf(c), chatBadge(c, true))),
          h('span', { class: 'chat-item-time', text: c.last_sender ? shortTime(c.last_message_at) : '' })),
        h('span', { class: 'chat-item-row' },
          h('span', { class: 'chat-item-last', text: previewOf(c) }),
          un ? h('span', { class: 'unread-dot' }) : null)));
  }));
}

/* ---------- Аватарка-фото ---------- */
async function squarePhoto(file, size = 320) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = h('canvas', { width: size, height: size });
  canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
}
async function setAvatarPhoto(file) {
  const me = state.me.id, p = state.people.get(me);
  const old = p.avatar_path;
  let path = null;
  if (file) {
    if (!file.type.startsWith('image/')) throw new Error('Нужна картинка');
    const blob = await squarePhoto(file);
    path = `${me}/${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')}.jpg`;
    const { error } = await sb.storage.from(AVATAR_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
    if (error) throw error;
  }
  const { error } = await sb.from('profiles').update({ avatar_path: path }).eq('id', me);
  if (error) { if (path) sb.storage.from(AVATAR_BUCKET).remove([path]); throw error; }
  p.avatar_path = path;
  if (old) sb.storage.from(AVATAR_BUCKET).remove([old]).catch?.(() => {});
  renderMe(); renderChats();
  if (state.activeId) { renderHeader(); renderMessages({ keepScroll: true }); }
}
function photoControls(msg, redraw) {
  if (!PROFILE_COLUMNS.includes('avatar_path')) return null;   // база ещё без update-8
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const wrap = h('div', { class: 'inline photo-controls' });
  const draw = () => wrap.replaceChildren(input,
    h('button', { class: 'btn', type: 'button', onclick: () => input.click() }, icon('camera'), photoOf(state.me.id) ? 'Сменить фото' : 'Поставить фото'),
    photoOf(state.me.id) ? h('button', { class: 'btn', type: 'button', text: 'Убрать', onclick: async () => {
      try { await setAvatarPhoto(null); redraw(); draw(); say(msg, 'Фото убрано', 'ok'); } catch (e) { say(msg, humanError(e)); }
    } }) : null);
  input.onchange = async () => {
    const f = input.files[0]; input.value = '';
    if (!f) return;
    say(msg, 'Загружаю фото…', 'ok');
    try { await setAvatarPhoto(f); redraw(); draw(); say(msg, 'Фото поставлено', 'ok'); } catch (e) { say(msg, humanError(e)); }
  };
  draw();
  return wrap;
}

/** Сохранить сообщение в «Избранное»: копия зашифрована ключом избранного */
async function saveToFavorites(m) {
  const target = state.savedId;
  if (!target) return;
  try {
    if (!(await canSend(target))) return;
    const f = { s: m.sender_id, n: nameOf(m.sender_id) };
    if (m.p.img) {
      const src = state.images.get(m.p.img.path || m.p.img.hash);
      if (!src) return inlineError('Фото ещё не загрузилось — подождите секунду');
      const blob = await (await fetch(src)).blob();
      await sendImage(new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' }), target, { t: m.p.t || '', f });
    } else {
      addMessage(await insertMessage(target, { t: m.p.t, f }));
    }
    toast('Сохранено в избранное');
  } catch (err) { inlineError(sendError(err)); }
}

/** «Избранное» — чат с самим собой. Создаётся один раз. */
async function ensureSaved() {
  const { data, error } = await sb.rpc('get_or_create_saved');
  if (error || !data) return;                             // база ещё без update-8
  state.savedId = data;
  if (!state.chats.has(data)) await loadChats(); else renderChats();
}

/** Открыть личный чат по нику (из поиска или по ссылке «Поделиться ником») */
async function openDirectByNick(raw) {
  const q = String(raw || '').trim().toLowerCase().replace(/^@/, '');
  if (!q) return;
  if (q === state.people.get(state.me.id).username) return say('findMsg', 'Это же вы');
  const { data, error } = await selectProfiles((x) => x.eq('username', q).maybeSingle());
  if (error) return say('findMsg', humanError(error));
  if (!data) return say('findMsg', `Не нашли @${q} — проверьте ник`);
  state.people.set(data.id, data);
  const { data: chatId, error: e2 } = await sb.rpc('get_or_create_dm', { other: data.id });
  if (e2) return say('findMsg', humanError(e2));
  say('findMsg', '');
  $('findInput').value = '';
  await loadChats();
  await openChat(chatId);
}
$('findForm').onsubmit = (e) => { e.preventDefault(); openDirectByNick($('findInput').value); };

/* ---------- Поделиться ником: QR, ссылка, AirDrop / Bluetooth через меню телефона ---------- */
const profileLink = (nick) => location.origin + location.pathname.replace(/index\.html$/, '') + '#u=' + encodeURIComponent(nick);
function openShareMe() {
  const nick = state.people.get(state.me.id).username;
  const url = profileLink(nick);
  const msg = note();
  const qr = h('div', { class: 'qr-card' });
  qr.innerHTML = qrSvg(url, 220);                       // только цифры и наши теги — безопасно
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); say(msg, 'Ссылка скопирована', 'ok'); }
    catch { linkBox.select(); say(msg, 'Выделил ссылку — скопируйте её'); }
  };
  const linkBox = h('input', { value: url, readOnly: true, onfocus: (e) => e.target.select() });
  openModal({ title: 'Поделиться ником' },
    h('div', { class: 'share-me' },
      qr,
      h('div', { class: 'profile-nick', text: '@' + nick }),
      h('p', { class: 'muted', text: 'Покажите QR другу: пусть наведёт камеру телефона. Или отправьте ссылку — откроется чат с вами.' })),
    linkBox,
    navigator.share ? h('button', { class: 'btn btn-primary btn-block', onclick: async () => {
      try { await navigator.share({ title: 'Мессенджер', text: `Пиши мне в Мессенджере: @${nick}`, url }); }
      catch (e) { if (e.name !== 'AbortError') copy(); }
    } }, icon('share'), 'Отправить: AirDrop, Bluetooth, мессенджеры') : null,
    h('button', { class: 'btn btn-block', onclick: copy }, icon('copy'), 'Скопировать ссылку'),
    msg);
}
$('shareBtn').onclick = () => openShareMe();

/** Ссылка вида …/messenger/#u=nick — сразу открыть чат */
async function handleProfileLink() {
  const m = location.hash.match(/^#u=([^&]+)/);
  if (!m || !state.me) return;
  window.history.replaceState(null, '', location.pathname + location.search);
  await openDirectByNick(decodeURIComponent(m[1]));
}
window.addEventListener('hashchange', handleProfileLink);

/* =====================================================================
   Открытый чат
   ===================================================================== */
const PAGE = 200;
const MSG_COLUMNS = 'id, conversation_id, sender_id, ct, iv, created_at, edited_at, cid, ct_hash, sig, nodes, key_version';

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
    $('chatStatus').replaceChildren(h('span', { class: 'typing' }, c.is_group ? `${nameOf(state.typing.who)} печатает` : 'печатает',
      h('span', { class: 'typing-dots' }, h('i'), h('i'), h('i'))));
    return;
  }
  const n = (c.member_ids || []).length;
  const members = `${n} ${plural(n, 'участник', 'участника', 'участников')}`;
  $('chatStatus').replaceChildren(icon('lock'),
    isSaved(c) ? 'Только для вас: заметки и сохранённое' : c.is_group ? (c.is_official ? 'Официальный чат · ' + members : members) : nickOf(otherOf(c)));
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
  state.seen.delete(id);                                  // при открытии — без анимации каждого пузыря
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
      .eq('conversation_id', id).order('created_at', { ascending: false }).limit(PAGE);
    if (error) { $('messages').replaceChildren(h('div', { class: 'inline-err', text: humanError(error) })); return; }
    const merged = new Map([...(state.history.get(id) || []), ...data].map((m) => [m.id, m]));
    state.history.set(id, [...merged.values()].sort(byTime));
    state.more.set(id, data.length === PAGE);
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

async function loadOlder(chatId, button) {
  const list = state.history.get(chatId) || [];
  if (!list.length) return;
  button.disabled = true;
  button.textContent = 'Загрузка…';
  const { data, error } = await sb.from('messages').select(MSG_COLUMNS)
    .eq('conversation_id', chatId).lt('created_at', list[0].created_at)
    .order('created_at', { ascending: false }).limit(PAGE);
  if (error) { button.disabled = false; button.textContent = 'Не получилось — ещё раз'; return; }
  await loadPeople(data.map((m) => m.sender_id));
  await Promise.all(data.map(decryptMessage));
  const merged = new Map([...data, ...list].map((m) => [m.id, m]));
  state.history.set(chatId, [...merged.values()].sort(byTime));
  state.more.set(chatId, data.length === PAGE);
  if (state.activeId !== chatId) return;
  const box = $('messages');
  const fromBottom = box.scrollHeight - box.scrollTop;
  renderMessages({ keepScroll: true });
  box.scrollTop = box.scrollHeight - fromBottom;          // остаёмся на том же месте
}

function renderMessages({ keepScroll = false } = {}) {
  const box = $('messages');
  const c = state.chats.get(state.activeId);
  const list = state.history.get(state.activeId) || [];
  const nodes = [];
  if (state.more.get(state.activeId)) {
    const chatId = state.activeId;
    const more = h('button', { class: 'btn load-more', type: 'button', text: 'Показать более ранние' });
    more.onclick = () => loadOlder(chatId, more);
    nodes.push(more);
  }

  nodes.push(h('div', { class: 'sys-note' }, icon('lock'),
    h('span', { text: hasCurrentKey(state.activeId)
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

  const firstRender = !state.seen.has(state.activeId);
  const seen = state.seen.get(state.activeId) || new Set();
  state.seen.set(state.activeId, seen);
  let lastDay = '', prev = null;
  for (const m of list) {
    const key = m.cid || m.id;
    const fresh = !firstRender && !seen.has(key);
    seen.add(key);
    const day = dayOf(m.created_at);
    if (day !== lastDay) { nodes.push(h('div', { class: 'day', text: day })); lastDay = day; prev = null; }
    const continued = prev && prev.sender_id === m.sender_id && ts(m.created_at) - ts(prev.created_at) < 5 * 60e3;
    nodes.push(bubble(m, { showName: c?.is_group && m.sender_id !== state.me.id && !continued, continued, fresh }));
    prev = m;
  }
  const prevTop = box.scrollTop;
  box.replaceChildren(...nodes);
  if (firstRender) {
    box.classList.remove('chat-enter'); void box.offsetWidth; box.classList.add('chat-enter');
    clearTimeout(box.enterT); box.enterT = setTimeout(() => box.classList.remove('chat-enter'), 450);
  }
  resolveImages(box);
  box.scrollTop = keepScroll ? prevTop : box.scrollHeight;
}

function bubble(m, { showName, continued, fresh }) {
  const p = m.p;
  const mine = m.sender_id === state.me.id;
  if (!mine && state.blocked.has(m.sender_id)) {
    return h('div', { class: 'msg hidden-msg', dataset: { id: m.id } }, 'Сообщение от заблокированного пользователя');
  }
  const classes = ['msg', mine && 'mine', p?.img && 'photo', (!p || p.bad || p.missing) && 'locked', continued && 'cont', m.sigOk === false && 'forged', fresh && 'msg-in'];
  const el = h('div', { class: classes.filter(Boolean).join(' '), dataset: { id: m.id } });
  if (showName) {
    el.append(h('div', { class: 'msg-from', vars: { '--h': hueOfUser(m.sender_id) } }, nameLine(nameOf(m.sender_id), roleBadge(m.sender_id))));
  }
  if (p?.f) el.append(h('div', { class: 'msg-fwd' }, icon('bookmark'), p.f.s === state.me.id ? 'Ваше сообщение' : 'От ' + (state.people.has(p.f.s) ? nameOf(p.f.s) : p.f.n || '…')));
  if (p?.r) {
    el.append(h('button', { class: 'msg-quote', type: 'button', onclick: () => jumpTo(p.r.id) },
      h('b', { text: nameOf(p.r.s) }), h('span', { text: p.r.t ? stripMarkdown(p.r.t) : 'Фото' })));
  }
  if (p?.img) {
    const img = h('img', { class: 'msg-img', alt: 'Фото', dataset: {
      ref: p.img.path || p.img.hash, path: p.img.path || '', hash: p.img.hash || '', nodes: (p.img.nodes || []).join(','),
      aad: p.img.a === 2 ? 'img|' + m.conversation_id : p.img.path, iv: p.img.iv, mime: p.img.mime || 'image/jpeg', chat: m.conversation_id,
      kv: p.img.kv || m.key_version || 1,
    } });
    if (p.img.w && p.img.h) img.style.aspectRatio = `${p.img.w} / ${p.img.h}`;
    img.onclick = () => img.src && openLightbox(img.src);
    el.append(img);
  }
  const text = !p ? 'Сообщение ещё не расшифровано'
    : p.missing ? 'Сообщение сейчас недоступно: узлы сети не отвечают'
    : p.bad ? 'Не удалось расшифровать' : p.t;
  if (text) el.append(p?.t && text === p.t ? h('div', { class: 'msg-text md' }, renderMarkdown(text)) : h('div', { class: 'msg-text', text }));
  if (m.sigOk === false) el.append(h('div', { class: 'msg-forged' }, icon('warn'), 'Подпись не совпадает — возможна подделка'));

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
  if (!m.p || m.p.bad || m.p.missing) return;
  const mine = m.sender_id === state.me.id;
  const c = state.chats.get(m.conversation_id);
  const items = [];
  if (c && !writeBlock(c)) items.push(['reply', 'Ответить', () => setCompose({ mode: 'reply', msg: m })]);
  if (m.p.t) items.push(['copy', 'Копировать', () => navigator.clipboard?.writeText(m.p.t)]);
  if (state.savedId && m.conversation_id !== state.savedId) items.push(['bookmark', 'В избранное', () => saveToFavorites(m)]);
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
  if (m.nodes?.length && m.ct_hash) net.del(m.nodes, `${m.conversation_id}/${m.ct_hash}`);
  if (m.p?.img?.hash && m.p.img.nodes?.length) net.del(m.p.img.nodes, `${m.conversation_id}/${m.p.img.hash}`);
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
    if (c) setLast(c, list[list.length - 1]);
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
  $('composeText').textContent = p.t ? stripMarkdown(p.t) : 'Фото';
  $('composeBar').hidden = false;
  if (next.mode === 'edit') { textArea.value = p.t || ''; autosize(); }
  textArea.focus();
}

function resolveImages(root) {
  for (const img of root.querySelectorAll('img[data-ref]')) {
    const { ref, path, hash, nodes, aad, iv, mime, chat } = img.dataset;
    if (state.images.has(ref)) { img.src = state.images.get(ref); continue; }
    (async () => {
      try {
        const key = chatKey(chat, +img.dataset.kv || 1);
        if (!key) return;
        let cipher;
        if (path) {
          const { data, error } = await sb.storage.from(BUCKET).download(path);
          if (error) throw error;
          cipher = await data.arrayBuffer();
        } else {
          cipher = await net.get(nodes.split(',').filter(Boolean), `${chat}/${hash}`, hash);
          if (!cipher) throw new Error('missing');
        }
        const plain = await E2E.openBytes(key, cipher, iv, aad);
        const url = URL.createObjectURL(new Blob([plain], { type: mime }));
        state.images.set(ref, url);
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

/** Короткое всплывающее сообщение внизу экрана */
function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status', text });
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 1800);
  setTimeout(() => t.remove(), 2200);
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
/** Ctrl/⌘ + B, I, U, E, Shift+X, Shift+P — обернуть выделенный текст разметкой */
const MD_KEYS = { b: '**', i: '*', u: '__', e: '`', X: '~~', P: '||' };
function wrapSelection(mark) {
  const { selectionStart: a, selectionEnd: b, value } = textArea;
  const sel = value.slice(a, b);
  textArea.setRangeText(mark + sel + mark, a, b, 'end');
  if (!sel) textArea.setSelectionRange(a + mark.length, a + mark.length);
  else textArea.setSelectionRange(a + mark.length, b + mark.length);
  textArea.dispatchEvent(new Event('input'));
}
textArea.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase();
    const mark = (e.shiftKey ? { X: MD_KEYS.X, P: MD_KEYS.P } : { b: MD_KEYS.b, i: MD_KEYS.i, u: MD_KEYS.u, e: MD_KEYS.e })[k];
    if (mark) { e.preventDefault(); wrapSelection(mark); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && isDesktop()) { e.preventDefault(); const f = $('composer'); f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event('submit', { cancelable: true })); }
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

/** Ключ чата сменился (кто-то вышел из группы)? Обновляем версию и получаем новый ключ. */
async function refreshKeyVersion(chatId) {
  const before = currentVersion(chatId);
  await loadChats();
  if (currentVersion(chatId) === before) return false;
  return ensureChatKey(chatId);
}
const isRlsError = (e) => /row-level security|stale key/i.test(String(e?.message || e));

async function insertMessage(chatId, payload, retried = false) {
  const row = await sealMessage(chatId, payload);
  const { data, error } = await sb.from('messages')
    .insert({ conversation_id: chatId, sender_id: state.me.id, ...row })
    .select(MSG_COLUMNS).single();
  if (error && !retried && isRlsError(error) && (await refreshKeyVersion(chatId))) return insertMessage(chatId, payload, true);
  if (error) throw error;
  data.p = payload;
  data.sigOk = row.sig ? true : null;
  return data;
}

/** Цитата для ответа: кто, что (коротко) и id исходного сообщения — всё внутри шифра */
function replyRef() {
  if (state.compose?.mode !== 'reply') return undefined;
  const m = state.compose.msg;
  return { id: m.id, s: m.sender_id, t: (m.p.t || (m.p.img ? 'Фото' : '')).slice(0, 120) };
}

async function editMessage(m, newText, retried = false) {
  const payload = { ...m.p, t: newText };
  const row = await sealMessage(m.conversation_id, payload, m.cid || uuid());
  delete row.cid;                                         // id сообщения при правке не меняется
  const oldKey = m.nodes?.length && m.ct_hash ? [m.nodes, `${m.conversation_id}/${m.ct_hash}`] : null;
  const { data, error } = await sb.from('messages').update(row).eq('id', m.id).select(MSG_COLUMNS).single();
  if (error && !retried && isRlsError(error) && (await refreshKeyVersion(m.conversation_id))) return editMessage(m, newText, true);
  if (error) throw error;
  if (oldKey) net.del(...oldKey);                         // старую версию убираем с узлов
  data.p = payload;
  data.sigOk = data.sig ? true : null;
  upsertMessage(data);
}

$('composer').onsubmit = async (e) => {
  const sendBtn = $('composer').querySelector('.send');
  if ($('text').value.trim()) { sendBtn.classList.remove('sent'); void sendBtn.offsetWidth; sendBtn.classList.add('sent'); }
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

const ALBUM_MAX = 10;
$('fileInput').onchange = async () => {
  const files = [...$('fileInput').files];
  $('fileInput').value = '';
  if (!files.length) return;
  if (!hasPlus() && files.length > 1) inlineError('Альбомы до 10 фото — с Плюсом. Отправляю первое фото.');
  const list = hasPlus() ? files.slice(0, ALBUM_MAX) : files.slice(0, 1);
  for (const f of list) await sendImage(f);
};

async function sendImage(file, target = null, extra = null) {
  const chatId = target || state.activeId;
  if (!chatId) return;
  if (!file.type.startsWith('image/')) return inlineError('Можно отправлять только картинки');
  if (!(await canSend(chatId))) return;
  const caption = extra ? (extra.t || '') : textArea.value.trim();
  $('uploading').hidden = false;
  let uploadedNodes = [], uploadedKey = null;
  try {
    const { blob, type, w, h: height } = await shrinkImage(file);
    if (blob.size > 6 * 1024 * 1024) throw new Error('Картинка слишком большая');
    const kv = currentVersion(chatId);
    const sealed = await E2E.sealBytes(chatKey(chatId, kv), await blob.arrayBuffer(), 'img|' + chatId);
    const bytes = new Uint8Array(sealed.data);
    const hash = await E2E.sha256hex(bytes);
    uploadedKey = `${chatId}/${hash}`;
    const img = { iv: sealed.iv, mime: type, w, h: height, a: 2, hash, kv };
    const nodes = await net.put(`${chatId}/${hash}`, bytes).catch(() => []);
    uploadedNodes = nodes;
    if (nodes.length) img.nodes = nodes;
    else {                                                // узлов нет — кладём в хранилище центра, как раньше
      img.path = `${chatId}/${uuid()}.bin`;
      const { error } = await sb.storage.from(BUCKET).upload(img.path, new Blob([bytes], { type: 'application/octet-stream' }),
        { contentType: 'application/octet-stream' });
      if (error) throw error;
    }
    state.images.set(img.path || hash, URL.createObjectURL(blob));
    const msg = await insertMessage(chatId, extra ? { t: caption, img, f: extra.f } : { t: caption, img, r: replyRef() });
    if (!extra) {
      if (caption) { textArea.value = ''; autosize(); }
      setCompose(null);
    }
    addMessage(msg);
  } catch (err) {
    if (uploadedNodes.length && uploadedKey) net.del(uploadedNodes, uploadedKey);   // не оставляем фото без сообщения
    inlineError(sendError(err).replace('Не отправилось', 'Фото не отправилось'));
  } finally {
    $('uploading').hidden = true;
  }
}

/** Уменьшаем фото до 1600 px (с Плюсом — до 2560 px): экономит бесплатный 1 ГБ хранилища. */
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  if (file.type === 'image/gif' && file.size < 4 * 1024 * 1024) return { blob: file, type: 'image/gif', w: bmp.width, h: bmp.height };
  const max = hasPlus() ? 2560 : 1600;                   // с Плюсом — фото в высоком качестве
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = h('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', hasPlus() ? 0.9 : 0.82));
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
    if (c && c.last_sender) c.last_p = (await decryptMessage(lastMessageOf(c))).p;
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
  if (c && list && list[list.length - 1]?.id === m.id) setLast(c, m);
  if (m.conversation_id === state.activeId) renderMessages();
  renderChats();
}

async function addMessage(m, fromServer = false) {
  if (!state.me) return;
  let c = state.chats.get(m.conversation_id);
  if (!c) { await loadChats(); c = state.chats.get(m.conversation_id); if (!c) return; }
  await loadPeople([m.sender_id]);
  if (!chatKey(c.id, m.key_version)) await loadChatKeys();
  await decryptMessage(m);

  const hist = state.history.get(c.id);
  const isNew = !hist || !hist.some((x) => x.id === m.id);
  if (hist && isNew) { hist.push(m); hist.sort(byTime); }

  if (!c.last_message_at || ts(c.last_message_at) <= ts(m.created_at)) {
    c.last_message_at = m.created_at;
    setLast(c, m);
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

/** Что показать в «Уведомлениях»: на iPhone объясняем, почему push может не работать. */
function pushBlock(standalone, pushToggle, msg) {
  const row = (title, sub, right) => h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('b', { text: title }), h('small', { text: sub })), right);
  if (iosVersion && (iosVersion[0] < 16 || (iosVersion[0] === 16 && iosVersion[1] < 4))) {
    return h('div', { class: 'push-help' },
      h('b', { text: `На этом iPhone push невозможен (iOS ${iosVersion.join('.')})` }),
      h('small', { text: 'Apple добавила уведомления для веб-приложений только в iOS 16.4. iPhone 7 и старше обновить до неё нельзя. Сообщения приходят, пока приложение открыто.' }));
  }
  if (isIOS && !standalone) {
    return h('div', { class: 'push-help' },
      h('b', { text: 'Чтобы получать уведомления на iPhone:' }),
      h('ol', {},
        h('li', { text: 'Откройте мессенджер именно в Safari (не в Telegram и не в Chrome).' }),
        h('li', { text: 'Нажмите «Поделиться» (квадрат со стрелкой) → «На экран „Домой“».' }),
        h('li', { text: 'Если есть переключатель «Открыть как веб-приложение» — включите его.' }),
        h('li', { text: 'Запустите мессенджер с иконки на экране и включите уведомления здесь.' })));
  }
  const status = h('small', { class: 'push-status' });
  (async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return status.textContent = 'Браузер не поддерживает push';
      const reg = swReg || await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      status.textContent = sub && Notification.permission === 'granted' ? '✓ Подписка на этом устройстве активна' : 'На этом устройстве выключены';
    } catch { status.textContent = ''; }
  })();
  const test = h('button', { class: 'btn', text: 'Проверить', onclick: async () => {
    try {
      if (Notification.permission !== 'granted') return say(msg, 'Сначала включите уведомления');
      const reg = swReg || await navigator.serviceWorker.ready;
      await reg.showNotification('Мессенджер', { body: 'Уведомления работают ✓', icon: 'icon-192.png', tag: 'test' });
      say(msg, 'Отправил проверочное уведомление', 'ok');
    } catch (e) { say(msg, 'Не получилось показать уведомление: ' + (e.message || e)); }
  } });
  return h('div', { style: { display: 'grid', gap: '8px' } },
    row('Push-уведомления', 'Приходят, даже когда приложение закрыто', pushToggle),
    h('div', { class: 'inline push-test' }, status, test));
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
  state.chats.delete(chatId); state.history.delete(chatId);
  for (const k of [...keys.chat.keys()]) if (k.startsWith(chatId + ':')) keys.chat.delete(k);
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
  if (isSaved(c)) {
    openModal({ title: 'Избранное' },
      h('div', { class: 'profile-head' }, savedAvatar('lg')),
      h('p', { text: 'Чат только для вас: заметки, ссылки, фото. Сохранить сюда чужое сообщение — долгое нажатие на него → «В избранное». Всё зашифровано, как и остальные чаты.' }));
    return;
  }
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
  const drawAvatar = () => avatarSlot.replaceChildren(avatar(name.value.trim() || p.username, hue, 'lg', null, frameOf(state.me.id) ? 'frame frame-' + frameOf(state.me.id) : '', photoOf(state.me.id)));
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
    h('div', { class: 'profile-head' }, avatarSlot, h('div', { class: 'name-line' }, roleBadge(state.me.id)), h('div', { class: 'profile-nick', text: '@' + p.username })),
    section('Профиль', name, swatches, photoControls(msg, drawAvatar), h('button', { class: 'btn btn-primary btn-block', text: 'Сохранить', onclick: async () => {
      const display_name = name.value.trim() || null;
      const { error } = await sb.from('profiles').update({ display_name, avatar_hue: hue }).eq('id', state.me.id);
      if (error) return say(msg, humanError(error));
      Object.assign(p, { display_name, avatar_hue: hue });
      renderMe(); renderChats();
      if (state.activeId) { renderHeader(); renderMessages(); }
      say(msg, 'Профиль сохранён', 'ok');
    } })),
    perksSection(msg),
    section('Оформление',
      segmented([['classic', 'Обычный'], ['dot', 'Dot']], prefs.style, (v) => smoothTheme(() => { prefs.style = v; savePrefs(); applyTheme(); })),
      segmented([['light', 'Светлая'], ['dark', 'Тёмная'], ['auto', 'Авто']], prefs.mode, (v) => { prefs.mode = v; savePrefs(); applyTheme(); })),
    section('Уведомления',
      pushBlock(standalone, pushToggle, msg),
      h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('b', { text: 'Звук' }), h('small', { text: 'Когда приложение открыто' })),
        toggle(prefs.sound, (e) => { prefs.sound = e.target.checked; savePrefs(); if (prefs.sound) ding(); }))),
    section('Как оформлять текст', h('div', { class: 'md-help' }, ...[
      ['**жирный**'], ['*курсив*'], ['__подчёркнутый__'], ['~~зачёркнутый~~'], ['||спойлер||'], ['`код`'],
      ['> цитата'], ['- список'], ['[ссылка](https://example.com)'],
    ].map(([src]) => h('div', { class: 'md-help-row' }, h('code', { text: src }), h('div', { class: 'md' }, renderMarkdown(src))))),
      isDesktop() ? h('p', { class: 'muted', text: 'Горячие клавиши: Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+E (код), Ctrl+Shift+X (зачеркнуть), Ctrl+Shift+P (спойлер).' }) : null),
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
    networkSection(msg),
    section('Заблокированные', blockedList),
    msg,
    h('button', { class: 'btn btn-danger btn-block', text: 'Выйти из аккаунта', onclick: signOut }),
    h('button', { class: 'btn btn-danger btn-block', text: 'Удалить аккаунт', onclick: () => deleteAccountDialog(p.username) }));
}

/* =====================================================================
   Сеть партнёров
   ===================================================================== */
/* =====================================================================
   Награды партнёрам: «Партнёр» и «Плюс»
   ===================================================================== */
const FRAMES = [[null, 'Нет'], ['gold', 'Золото'], ['aurora', 'Сияние'], ['neon', 'Неон'], ['dots', 'Точки']];
const PERKS = [
  'Значок у ника — его видят все',
  'Фото в высоком качестве и альбомы до 10 фото',
  'До 100 групп и до 500 человек в группе',
  'Свой цвет акцента, темы «Бумага» и «Неон», рамки аватарки',
];

function perksSection(msg) {
  const me = state.me.id;
  const kind = perkOf(me);
  const body = h('div', { style: { display: 'grid', gap: '12px' } });

  const status = kind === 'partner'
    ? h('div', { class: 'perk-card on' }, h('b', { text: 'Вы партнёр сети' }), h('small', { text: 'Ваш узел в сети — все награды включены. Спасибо!' }))
    : kind === 'plus'
      ? h('div', { class: 'perk-card on' }, h('b', { text: 'У вас Плюс' }), h('small', { text: 'Подарок от партнёра. Действует, пока его узел в сети.' }))
      : h('div', { class: 'perk-card' }, h('b', { text: 'Обычный аккаунт' }),
        h('small', { text: 'Всё общение бесплатно и без ограничений. Партнёры сети получают сверху:' }));
  const list = h('ul', { class: 'perk-list' }, ...PERKS.map((t) => h('li', { class: kind ? 'on' : '' }, kind ? '✓ ' : '· ', t)));
  body.append(status, list);

  if (!kind) {
    body.append(
      h('button', { class: 'btn btn-primary btn-block', onclick: partnerDialog }, 'Стать партнёром — это бесплатно'),
      h('p', { class: 'muted', text: 'Или попросите друга-партнёра подарить вам Плюс.' }));
  } else {
    // Рамка
    const frames = h('div', { class: 'frames' });
    const drawFrames = () => frames.replaceChildren(...FRAMES.map(([f, label]) => h('button', {
      class: 'frame-pick' + ((state.people.get(me)?.frame || null) === f ? ' on' : ''), title: label, type: 'button',
      onclick: async () => {
        const { error } = await sb.from('profiles').update({ frame: f }).eq('id', me);
        if (error) return say(msg, humanError(error));
        state.people.get(me).frame = f;
        drawFrames(); renderMe(); renderChats();
        say(msg, f ? 'Рамка «' + label + '» включена' : 'Рамка убрана', 'ok');
      },
    }, avatar(nameOf(me), hueOfUser(me), 'xs', null, f ? 'frame frame-' + f : ''), h('small', { text: label }))));
    drawFrames();

    // Акцент
    const accents = h('div', { class: 'swatches accent-swatches' });
    const drawAccents = () => accents.replaceChildren(
      h('button', { class: 'swatch none' + (prefs.accent == null ? ' on' : ''), title: 'Как в теме', type: 'button',
        onclick: () => { prefs.accent = null; savePrefs(); applyTheme(); drawAccents(); } }),
      ...[...HUES, 200, 120, 0].map((hh) => h('button', {
        class: 'swatch' + (hh === prefs.accent ? ' on' : ''), vars: { '--h': hh }, title: 'Акцент', type: 'button',
        onclick: () => smoothTheme(() => { prefs.accent = hh; savePrefs(); applyTheme(); drawAccents(); }),
      })));
    drawAccents();

    body.append(
      h('div', { class: 'row-text' }, h('b', { text: 'Рамка аватарки' }), h('small', { text: 'Видна всем, пока у вас есть Плюс' })), frames,
      h('div', { class: 'row-text' }, h('b', { text: 'Цвет акцента' }), h('small', { text: 'Кнопки и ваши сообщения' })), accents,
      h('div', { class: 'row-text' }, h('b', { text: 'Темы' })),
      segmented([['classic', 'Обычная'], ['dot', 'Dot'], ['paper', 'Бумага'], ['neon', 'Неон']], prefs.style,
        (v) => smoothTheme(() => { prefs.style = v; savePrefs(); applyTheme(); })));
  }

  if (kind === 'partner') body.append(giftsBlock(msg));
  body.append(topBlock());
  return section('Партнёрство', body);
}

function giftsBlock(msg) {
  const wrap = h('div', { style: { display: 'grid', gap: '10px' } });
  const nick = h('input', { placeholder: 'Ник друга', autocapitalize: 'off', spellcheck: 'false' });
  const draw = async () => {
    const { data } = await sb.from('partner_gifts').select('friend_id, created_at').eq('partner_id', state.me.id).order('created_at', { ascending: true });
    const ids = (data || []).map((g) => g.friend_id);
    await loadPeople(ids);
    wrap.replaceChildren(
      h('div', { class: 'row-text' }, h('b', { text: `Подарить Плюс друзьям: ${ids.length} из 5` }),
        h('small', { text: 'Друзья получают все награды, пока ваш узел в сети' })),
      ...ids.map((uid) => h('div', { class: 'member' }, userAvatar(uid, 'xs'),
        h('div', { class: 'row-text', style: { flex: '1' } }, h('b', { text: nameOf(uid) }), h('small', { text: nickOf(uid) })),
        h('button', { class: 'btn', text: 'Забрать', onclick: async () => {
          const { error } = await sb.rpc('ungift_plus', { p_friend: uid });
          if (error) return say(msg, humanError(error));
          await loadPerks(); draw();
        } }))),
      ids.length < 5 ? h('div', { class: 'inline' }, nick, h('button', { class: 'btn', text: 'Подарить', onclick: async () => {
        const u = nick.value.trim().replace(/^@/, '').toLowerCase();
        if (!u) return;
        const { error } = await sb.rpc('gift_plus', { p_username: u });
        if (error) return say(msg, /not found/i.test(error.message) ? `Не нашли @${u}` : humanError(error));
        nick.value = '';
        say(msg, `@${u} получил Плюс`, 'ok');
        await loadPerks(); draw();
      } })) : null);
  };
  draw();
  return wrap;
}

function topBlock() {
  const wrap = h('div', { style: { display: 'grid', gap: '8px' } }, h('b', { text: 'Лучшие партнёры' }));
  (async () => {
    const { data, error } = await sb.rpc('partner_top');
    if (error) return;
    if (!data?.length) return wrap.append(h('p', { class: 'muted', text: 'Пока никого. Станьте первым — место №1 свободно.' }));
    await loadPeople(data.map((r) => r.user_id));
    wrap.append(...data.map((r, i) => h('div', { class: 'member top-row' + (r.user_id === state.me.id ? ' me' : '') },
      h('span', { class: 'top-place', text: String(i + 1) }),
      userAvatar(r.user_id, 'xs'),
      h('div', { class: 'row-text', style: { flex: '1' } }, h('b', { text: r.display_name || r.username }),
        h('small', { text: `${r.msgs} ${plural(r.msgs, 'сообщение', 'сообщения', 'сообщений')} · ${r.days} ${plural(r.days, 'день', 'дня', 'дней')} в сети` })),
      h('span', { class: 'top-score', text: String(r.score) }))));
  })();
  return wrap;
}

const PARTNER_GUIDE = 'https://github.com/dnestruev/messenger/blob/main/partner/README.md';
const STATUS_LABEL = { active: 'в сети', pending: 'ждёт подтверждения', disabled: 'отключён' };

function networkSection(msg) {
  const body = h('div', { style: { display: 'grid', gap: '10px' } }, h('p', { text: 'Загрузка…' }));
  const isCreator = roleOf(state.me.id) === 'creator';
  (async () => {
    await net.load(true);
    const { data: stats } = await sb.rpc('node_stats');
    const activeCount = net.active().length;
    const list = (stats || []).map((n) => nodeRow(n, isCreator, msg));
    body.replaceChildren(
      h('p', { text: activeCount
        ? `Узлов-партнёров в сети: ${activeCount}. Сообщения и фото хранятся на них в двух копиях — зашифрованными.`
        : 'Узлов-партнёров пока нет: всё хранится на основном сервере.' }),
      ...list,
      h('button', { class: 'btn btn-block', onclick: partnerDialog }, icon('plus'), 'Стать партнёром'));
  })();
  return section(isCreator ? 'Сеть партнёров' : 'Сеть', body);
}

function nodeRow(n, isCreator, msg) {
  const host = n.url.replace('https://', '').replace('.supabase.co', '');
  const info = h('div', { class: 'row-text' },
    h('b', { text: host }),
    h('small', { text: [STATUS_LABEL[n.status] + (n.disabled_reason ? ` (${n.disabled_reason})` : ''),
      n.owner_username ? '@' + n.owner_username : null,
      isCreator && n.reports_24h ? `жалоб за сутки: ${n.reports_24h}` : null].filter(Boolean).join(' · ') }));
  const check = h('button', { class: 'btn', text: 'Проверить', onclick: async () => {
    check.disabled = true;
    say(msg, (await net.health(n.url)) ? `${host}: узел отвечает` : `${host}: узел не отвечает`, 'ok');
    check.disabled = false;
  } });
  const actions = [check];
  if (isCreator) {
    const next = n.status === 'active' ? 'disabled' : 'active';
    actions.push(h('button', { class: 'btn', text: next === 'active' ? 'Включить' : 'Отключить', onclick: async () => {
      if (next === 'active' && !(await net.health(n.url))) return say(msg, 'Узел не отвечает — включать нельзя. Проверьте функцию node у партнёра.');
      const { error } = await sb.rpc('set_node_status', { p_node: n.id, p_status: next });
      if (error) return say(msg, humanError(error));
      openSettings();
    } }));
  }
  if (isCreator || n.owner_username === state.people.get(state.me.id)?.username) {
    actions.push(h('button', { class: 'icon-btn', title: 'Удалить узел', onclick: async () => {
      if (!confirm('Удалить узел из сети? Данные с него будут недоступны, если других копий нет.')) return;
      const { error } = await sb.rpc('delete_node', { p_node: n.id });
      if (error) return say(msg, humanError(error));
      openSettings();
    } }, icon('trash')));
  }
  return h('div', { class: 'node-row' }, h('span', { class: 'node-dot ' + n.status }), info, h('div', { class: 'node-actions' }, ...actions));
}

function partnerDialog() {
  const url = h('input', { placeholder: 'https://xxxxxxxxxxxxxxxxxxxx.supabase.co', autocapitalize: 'off', spellcheck: 'false', inputmode: 'url' });
  const msg = note();
  const go = h('button', { class: 'btn btn-primary btn-block', text: 'Проверить и отправить заявку' });
  openModal({ title: 'Стать партнёром' },
    h('p', { text: 'Партнёр отдаёт сети свой бесплатный проект Supabase: на нём хранятся зашифрованные копии сообщений и фото. Прочитать или подделать их партнёр не может — всё проверяется по хешам и подписям.' }),
    section('Как подключить узел',
      h('p', {}, '1. Создайте бесплатный проект на supabase.com.'),
      h('p', {}, '2. SQL Editor → выполните файл ', h('b', { text: 'partner/node.sql' }), '.'),
      h('p', {}, '3. Edge Functions → Via Editor → имя ', h('b', { text: 'node' }), ', вставьте ', h('b', { text: 'partner/functions/node/index.ts' }), ', Deploy, затем выключите Verify JWT.'),
      h('p', {}, '4. Вставьте ниже адрес проекта (Project URL).'),
      h('a', { href: PARTNER_GUIDE, target: '_blank', rel: 'noopener', class: 'btn btn-block' }, 'Подробная инструкция и файлы')),
    h('label', { class: 'field' }, h('span', { text: 'Адрес вашего проекта' }), url),
    go, msg);
  go.onclick = async () => {
    const value = url.value.trim().toLowerCase().replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(value)) return say(msg, 'Адрес должен быть вида https://xxxxxxxxxxxxxxxxxxxx.supabase.co');
    if (value === SUPABASE_URL) return say(msg, 'Это адрес основного сервера — нужен отдельный проект');
    go.disabled = true;
    say(msg, 'Проверяю узел…', 'ok');
    if (!(await net.health(value))) {
      go.disabled = false;
      return say(msg, 'Узел не отвечает. Проверьте, что функция называется node, развёрнута и Verify JWT выключен.');
    }
    const { error } = await sb.rpc('register_node', { p_url: value });
    go.disabled = false;
    if (error) return say(msg, /already/i.test(error.message) ? 'Этот узел уже зарегистрирован' : humanError(error));
    say(msg, 'Заявка отправлена! Узел заработает, когда создатель его подтвердит.', 'ok');
    url.value = '';
  };
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
