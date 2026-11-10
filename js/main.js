import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from '../config.js?v=20261110165000';
import * as CONFIG from '../config.js?v=20261110165000';
import * as E2E from './crypto.js?v=20261110165000';
import { createNet } from './net.js?v=20261110165000';
import { qrSvg } from './qr.js?v=20261110165000';
import { findEmbed } from './embeds.js?v=20261110165000';
import { STICKERS, stickerSvg, stickerLabel } from './stickers.js?v=20261110165000';
import { renderMarkdown, stripMarkdown } from './md.js?v=20261110165000';
import { CALL_BETA, prepareVideo, createCallExtras } from './call-extras.js?v=20261110165000';
import { DEFAULT_ICE_SERVERS, hasTurn, loadIceConfiguration, describeCandidates, selectedRoute } from './calls.js?v=20261110165000';

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
const fmtDur = (sec) => { sec = Math.max(0, Math.round(sec || 0)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
// Форматтеры создаём один раз: toLocale…String на каждый вызов заново собирает их и заметно тормозит длинную ленту
const FMT_TIME = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const FMT_SHORT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const FMT_DAY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const timeOf = (iso) => FMT_TIME.format(new Date(iso));
const shortDate = (iso) => FMT_SHORT.format(new Date(iso));
function shortTime(iso) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? timeOf(iso) : shortDate(iso);
}
const dayOf = (iso) => FMT_DAY.format(new Date(iso));
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
    [/Database error saving new user/i, 'Этот ник только что заняли — выберите другой'],
    [/Unable to validate email|invalid format/i, 'Проверьте email: похоже, в нём опечатка'],
    [/too many nodes/i, 'Можно подключить не больше 3 узлов'],
    [/stale key/i, 'Ключ чата обновился — попробуйте ещё раз'],
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
  online: new Set(),        // кто сейчас в сети (Realtime Presence)
  lastSeen: new Map(),      // id -> { at: Date|null, recently }
  hideSeen: false,
  reactions: new Map(),     // id сообщения -> Map(id человека -> эмодзи)
  shown: new Map(),         // id чата -> сколько последних сообщений нарисовано
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
let modalOnClose = null;
function openModal({ title, locked = false, onClose = null }, ...body) {
  const prev = modalOnClose; modalOnClose = null; prev?.();
  modalOnClose = onClose;
  modalLocked = locked;
  const head = h('div', { class: 'modal-head' }, h('h3', { text: title }),
    locked ? null : h('button', { class: 'icon-btn', title: 'Закрыть', onclick: closeModal }, icon('close')));
  const overlay = h('div', { class: 'overlay' }, h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, head, ...body));
  if (!locked) overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
  $('modalRoot').replaceChildren(overlay);
  return overlay;
}
function closeModal() { modalLocked = false; $('modalRoot').replaceChildren(); const f = modalOnClose; modalOnClose = null; f?.(); }
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
const FULL_PROFILE_COLUMNS = PROFILE_COLUMNS;
async function selectProfiles(build) {
  if (PROFILE_COLUMNS !== FULL_PROFILE_COLUMNS) {          // база могла обновиться, пока приложение открыто
    const full = await build(sb.from('profiles').select(FULL_PROFILE_COLUMNS));
    if (!full.error) { PROFILE_COLUMNS = FULL_PROFILE_COLUMNS; return full; }
  }
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
/** Свежий профиль одного человека (перед показом его профиля) */
async function refreshPerson(id) {
  const { data } = await selectProfiles((q) => q.eq('id', id).maybeSingle());
  if (data) state.people.set(id, data);
}
/** Профиль любого человека: фото крупно, ник, «Написать» */
async function openUserProfile(uid, backTo = null) {
  if (uid === state.me.id) return openSettings();
  await refreshPerson(uid);
  const msg = note();
  openModal({ title: 'Профиль' },
    h('div', { class: 'profile-head' }, zoomAvatar(userAvatar(uid, 'lg'), uid),
      h('div', { class: 'profile-name' }, nameLine(nameOf(uid), roleBadge(uid))), h('div', { class: 'profile-nick', text: nickOf(uid) })),
    msg,
    h('button', { class: 'btn btn-primary btn-block', onclick: async () => { closeModal(); await openDirectByNick(state.people.get(uid)?.username); } }, icon('chat'), 'Написать'),
    backTo ? h('button', { class: 'btn btn-block', text: 'Назад к группе', onclick: () => openChatInfo(backTo) }) : null);
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
    photo ? h('img', { class: 'avatar-img', src: photo, alt: '', decoding: 'sync', draggable: false,
      onerror: (e) => { e.target.parentNode?.classList.remove('has-photo'); e.target.remove(); } }) : null,
    badge ? h('span', { class: 'badge' }, icon(badge)) : null);
}
const roleOf = (id) => state.people.get(id)?.role || null;
const ROLE_LABEL = { creator: 'Создатель', tester: 'Тестер' };
const perkOf = (id) => state.perks.get(id) || null;
const hasPlus = (id = state.me?.id) => !!perkOf(id);
const PERK_LABEL = { partner: 'Партнёр', plus: 'Плюс' };
const PERK_TITLE = { partner: 'Держит узел сети: хранит зашифрованные сообщения для всех', plus: 'Плюс в подарок от партнёра сети' };
/** Информация о подтверждённых статусах пользователя. Права определяет база, не значок. */
const STATUS_INFO = {
  creator: {
    label: 'Создатель',
    description: 'Создатель проекта и участник команды мессенджера.',
    benefits: ['Управление тестерами', 'Управление партнёрскими узлами', 'Возможность создавать официальные чаты и писать в них'],
  },
  tester: {
    label: 'Тестер',
    description: 'Участник команды тестирования мессенджера.',
    benefits: ['Значок тестера у имени', 'Возможность писать в официальных чатах', 'Участие в тестировании новых функций'],
  },
  partner: {
    label: 'Партнёр',
    description: 'Владелец активного партнёрского узла, который хранит зашифрованные данные сети.',
    benefits: ['Значок партнёра', 'Фото высокого качества и альбомы до 10 фото', 'До 100 групп и 500 участников в группе', 'Дополнительные темы, рамки и цвет акцента', 'Возможность подарить Плюс друзьям'],
  },
  plus: {
    label: 'Плюс',
    description: 'Дополнительные возможности, полученные в подарок от активного партнёра сети.',
    benefits: ['Значок Плюс', 'Фото высокого качества и альбомы до 10 фото', 'До 100 групп и 500 участников в группе', 'Дополнительные темы, рамки и цвет акцента'],
  },
};

/** Проверка выполняется по свежим данным Supabase, а не по надписи в браузере. */
async function openStatusInfo(uid, kind) {
  const info = STATUS_INFO[kind];
  if (!info || !state.me) return;
  document.querySelector('.status-info-overlay')?.remove();
  const status = h('div', { class: 'status-check', role: 'status', text: 'Проверяем статус на сервере…' });
  const badge = h('span', { class: 'role ' + kind, text: info.label });
  const bullets = h('ul', { class: 'status-benefits' }, ...info.benefits.map((t) => h('li', { text: t })));
  let overlay;
  const close = () => {
    document.removeEventListener('keydown', onEscape, true);
    overlay?.remove();
  };
  const onEscape = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  };
  overlay = h('div', { class: 'overlay status-info-overlay' },
    h('div', { class: 'modal status-info-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Информация о значке' },
      h('div', { class: 'modal-head' }, h('h3', { text: 'Статус пользователя' }),
        h('button', { class: 'icon-btn', type: 'button', title: 'Закрыть', onclick: close }, icon('close'))),
      h('div', { class: 'status-info-heading' }, badge,
        h('b', { text: nameOf(uid) }),
        h('small', { text: nickOf(uid) })),
      status,
      h('p', { text: info.description }),
      h('b', { text: 'Возможности и привилегии' }),
      bullets,
      h('p', { class: 'status-info-note', text: 'Статус проверяется по данным сервера Supabase. Оформление значка само по себе не предоставляет прав.' }),
      h('button', { class: 'btn btn-block', type: 'button', text: 'Понятно', onclick: close })));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  document.addEventListener('keydown', onEscape, true);
  try {
    let confirmed = false;
    if (kind === 'creator' || kind === 'tester') {
      const { data, error } = await sb.from('profiles').select('role').eq('id', uid).maybeSingle();
      if (error) throw error;
      confirmed = data?.role === kind;
    } else {
      const { data, error } = await sb.rpc('perks_list');
      if (error) throw error;
      confirmed = (data || []).some((row) => row.user_id === uid && row.kind === kind);
    }
    if (!overlay.isConnected) return;
    status.classList.add(confirmed ? 'verified' : 'unverified');
    status.textContent = confirmed
      ? '✓ Подтверждено сервером: статус действителен'
      : 'Статус не подтверждён: он мог измениться. Обновите страницу.';
  } catch (err) {
    if (!overlay.isConnected) return;
    status.textContent = 'Не удалось проверить статус. Проверьте соединение и повторите.';
    console.warn('Ошибка проверки статуса', err);
  }
}

function clickableBadge(id, kind, compact = false) {
  const team = kind === 'creator' || kind === 'tester';
  const label = (team ? ROLE_LABEL : PERK_LABEL)[kind];
  const shown = !team && compact ? (kind === 'partner' ? '★' : '+') : label;
  const open = (e) => { e.preventDefault(); e.stopPropagation(); openStatusInfo(id, kind); };
  return h('span', {
    class: 'role ' + kind + (!team && compact ? ' mini' : '') + ' status-clickable',
    role: 'button', tabindex: 0,
    title: 'Нажмите, чтобы проверить статус «' + label + '»',
    'aria-label': 'Проверить статус «' + label + '»',
    onclick: open,
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') open(e); },
    text: shown,
  });
}

/** compact — маленькая награда в списке чатов и шапке. */
function roleBadge(id, compact = false) {
  const r = roleOf(id), k = perkOf(id);
  return [
    r && ROLE_LABEL[r] ? clickableBadge(id, r) : null,
    k && PERK_LABEL[k] ? clickableBadge(id, k, compact) : null,
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
  $('fileInput').multiple = true;                       // файлов можно сколько угодно; фото альбомом — с Плюсом
}
/** Имя + значок роли (или галочка официального чата) с обрезкой длинного текста */
const nameLine = (text, ...after) => h('span', { class: 'name-line' }, h('span', { class: 't', text }), ...after);
const userAvatar = (id, size) => avatar(nameOf(id), hueOfUser(id), size, null, [roleOf(id), frameOf(id) && 'frame frame-' + frameOf(id)].filter(Boolean).join(' '), photoOf(id));
const isStaffMe = () => !!roleOf(state.me.id);
const isSaved = (c) => !!c && c.id === state.savedId;
const otherOf = (c) => (c.member_ids || []).find((id) => id !== state.me.id);
const titleOf = (c) => (isSaved(c) ? 'Избранное' : c.is_group ? c.title || 'Группа' : nameOf(otherOf(c)));
const savedAvatar = (size) => h('span', { class: ['avatar', 'saved-avatar', size].filter(Boolean).join(' ') }, icon('bookmark'));
const chatAvatar = (c, size) => {
  if (isSaved(c)) return savedAvatar(size);
  if (c.is_group) return avatar(c.title, hueOf(c.title), size, c.is_official ? 'verified' : 'users');
  const el = userAvatar(otherOf(c), size);
  if (isOnline(otherOf(c))) el.classList.add('is-online');
  return el;
};
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
  // Если сохранилась только одна копия на узле, сохраняем второй экземпляр в центре.
  const row = { cid, iv, ct_hash, ct: nodes.length >= 2 ? null : ct, nodes: nodes.length ? nodes : null, sig: null, key_version: v };
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
  $('forgotBtn').hidden = m !== 'login';
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

let recoveryPending = false;          // пришли по ссылке «сбросить пароль» из письма
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') recoveryPending = true;
  setTimeout(async () => {
    if (!session) return stopApp();
    await startApp(session.user);
    if (recoveryPending && state.me) { recoveryPending = false; newPasswordDialog(); }
  }, 0);
});

/** Забыли пароль: письмо со ссылкой. По ссылке приложение откроется и попросит новый пароль. */
$('forgotBtn').onclick = async () => {
  const email = $('email').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return say('authMsg', 'Впишите email выше — пришлём на него ссылку');
  $('forgotBtn').disabled = true;
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  $('forgotBtn').disabled = false;
  say('authMsg', error ? humanError(error) : 'Если такой аккаунт есть, письмо со ссылкой уже летит. Проверьте почту (и «Спам»).', error ? 'err' : 'ok');
};
function newPasswordDialog() {
  const pass = h('input', { type: 'password', placeholder: 'Новый пароль, от 6 символов', autocomplete: 'new-password' });
  const msg = note();
  const go = h('button', { class: 'btn btn-primary btn-block', text: 'Сохранить пароль', onclick: async () => {
    if (pass.value.length < 6) return say(msg, 'Пароль должен быть от 6 символов');
    go.disabled = true;
    const { error } = await sb.auth.updateUser({ password: pass.value });
    go.disabled = false;
    if (error) return say(msg, humanError(error));
    closeModal(); toast('Пароль изменён');
  } });
  pass.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
  openModal({ title: 'Новый пароль' }, h('p', { text: 'Придумайте новый пароль для входа.' }), pass, go, msg);
  pass.focus();
}

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
    $('chatList').replaceChildren(h('div', { class: 'list-empty' }, humanError(err),
      h('button', { class: 'btn', style: { marginTop: '12px' }, text: 'Повторить', onclick: () => location.reload() })));
    return;
  }
  const alive = () => state.me?.id === user.id;              // пока шёл запуск, могли выйти из аккаунта
  await loadChatKeys();
  await loadBlocks();
  await loadPerks();
  if (!alive()) return;
  $('chatList').classList.add('list-enter');
  await loadChats();
  await ensureSaved();
  if (!alive()) return;
  scheduleCleanup();
  setTimeout(() => $('chatList').classList.remove('list-enter'), 600);
  clearInterval(state.perksTimer);
  state.perksTimer = setInterval(loadPerks, 2 * 60 * 1000);
  subscribe();
  startPresence();
  startCallInbox();
  shareAllChatKeys();
  if (prefs.notify && 'Notification' in window && Notification.permission === 'granted') setupPush(true).catch(() => {});

  const deep = location.hash.match(/c=([0-9a-f-]{36})/);
  if (deep) { window.history.replaceState(null, '', location.pathname); openChat(deep[1]); }
  else handleProfileLink();
}
// Вернулись в приложение (телефон разблокировали) — освежаем значки и профили
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me) loadPerks(); if (!document.hidden) checkUpdate(); });

/* ---------- Новая версия сайта: предлагаем обновиться ---------- */
let loadedVersion = null;
async function siteVersion() {
  try { const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' }); return r.ok ? (await r.json()).v : null; }
  catch { return null; }
}
async function checkUpdate() {
  const v = await siteVersion();
  if (!v) return;
  if (!loadedVersion) { loadedVersion = v; return; }
  if (v === loadedVersion || document.querySelector('.update-bar')) return;
  document.body.append(h('div', { class: 'update-bar', role: 'status' },
    h('span', { text: 'Вышло обновление мессенджера' }),
    h('button', { class: 'btn btn-primary', text: 'Обновить', onclick: () => location.reload() })));
}
checkUpdate();
setInterval(checkUpdate, 3 * 60 * 1000);

/* =====================================================================
   В сети / был(а) недавно
   ===================================================================== */
let presence = null, seenTimer = null;
function startPresence() {
  stopPresence();
  const me = state.me.id;
  presence = sb.channel('online', { config: { presence: { key: me } } });
  presence.on('presence', { event: 'sync' }, () => {
    // В канале — все, кто в сети. Перерисовываем, только если зашёл или вышел кто-то из МОИХ чатов:
    // раньше любой вход/выход любого человека перерисовывал список у всех.
    const mine = new Set([...state.chats.values()].flatMap((c) => c.member_ids || []));
    const next = new Set(Object.keys(presence.presenceState() || {}));
    const came = [...next].some((id) => mine.has(id) && !state.online.has(id));
    const left = [...state.online].some((id) => mine.has(id) && !next.has(id));
    state.online = next;
    if (came || left) { renderChats(); if (state.activeId) renderHeader(); }
    if (left) setTimeout(loadSeen, 1500);                  // кто-то вышел — узнаём, когда он был в последний раз
  });
  presence.subscribe((status) => { if (status === 'SUBSCRIBED' && !document.hidden) presence.track({ at: Date.now() }); });
  sb.rpc('touch_seen').then(() => {}, () => {});
  seenTimer = setInterval(() => { if (!document.hidden) sb.rpc('touch_seen').then(() => {}, () => {}); loadSeen(); }, 2 * 60 * 1000);
  loadSeen();
}
function stopPresence() {
  clearInterval(seenTimer);
  if (presence) { try { presence.untrack(); } catch {} sb.removeChannel(presence); presence = null; }
  state.online.clear();
}
document.addEventListener('visibilitychange', () => {
  if (!presence || !state.me) return;
  if (document.hidden) { presence.untrack(); sb.rpc('touch_seen').then(() => {}, () => {}); }
  else { presence.track({ at: Date.now() }); sb.rpc('touch_seen').then(() => {}, () => {}); loadSeen(); }
});
/** Время последнего визита собеседников из личных чатов */
async function loadSeen() {
  const ids = [...new Set([...state.chats.values()].filter((c) => !c.is_group && !isSaved(c)).map(otherOf).filter(Boolean))];
  if (!ids.length) return;
  const { data, error } = await sb.rpc('seen_of', { p_ids: ids });
  if (error) return;                                      // база ещё без update-9
  for (const r of data || []) state.lastSeen.set(r.user_id, { at: r.seen_at ? new Date(r.seen_at) : null, recently: r.recently });
  if (state.activeId) renderHeader();
}
const isOnline = (id) => !!id && id !== state.me?.id && state.online.has(id);
function seenText(id) {
  if (isOnline(id)) return 'в сети';
  const s = state.lastSeen.get(id);
  if (!s) return null;
  if (!s.at) return s.recently ? 'был(а) недавно' : 'был(а) давно';
  const min = Math.floor((Date.now() - s.at) / 60000);
  if (min < 1) return 'был(а) только что';
  if (min < 60) return `был(а) ${min} ${plural(min, 'минуту', 'минуты', 'минут')} назад`;
  const today = new Date().toDateString() === s.at.toDateString();
  const yest = new Date(Date.now() - 864e5).toDateString() === s.at.toDateString();
  if (today) return 'был(а) в ' + timeOf(s.at);
  if (yest) return 'был(а) вчера в ' + timeOf(s.at);
  return 'был(а) ' + shortDate(s.at);
}

function stopApp() {
  state.me = null;
  state.activeId = null;
  state.people.clear(); state.chats.clear(); state.history.clear(); state.blocked.clear(); state.reads.clear();
  state.showArchive = false;
  clearInterval(state.perksTimer); state.perks.clear(); state.seen.clear(); state.savedId = null;
  stopPresence(); state.lastSeen.clear(); state.reactions.clear(); state.shown.clear();
  stopCalls();
  setCompose(null);
  leaveTyping();
  for (const url of state.images.values()) URL.revokeObjectURL(url);
  state.images.clear();
  for (const a of voiceAudio.values()) { try { a.pause(); } catch {} }
  voiceAudio.clear(); playing = null;
  seenSignals.clear(); endedCalls.clear();
  clearTimeout(removeMessage.t);
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

/** Список чатов. Вызовы, пришедшие во время загрузки, склеиваются в одну повторную загрузку,
    а старый список держится до готовности нового — иначе он на миг пустеет и мигает. */
let chatsLoading = null, chatsAgain = false;
function loadChats() {
  if (chatsLoading) { chatsAgain = true; return chatsLoading; }
  chatsLoading = (async () => {
    try {
      do { chatsAgain = false; await loadChatsOnce(); } while (chatsAgain && state.me);
    } finally { chatsLoading = null; }
  })();
  return chatsLoading;
}
async function loadChatsOnce() {
  const me = state.me?.id;
  const { data, error } = await sb.rpc('my_chats');
  if (state.me?.id !== me || !me) return;
  if (error) { if (!state.chats.size) $('chatList').replaceChildren(h('div', { class: 'list-empty', text: humanError(error) })); return; }
  const previous = new Map(state.chats);
  await Promise.all(data.map(async (c) => {
    c.keyWarn = previous.get(c.id)?.keyWarn;
    const prevLast = previous.get(c.id);
    // если последнее сообщение не изменилось — не скачиваем его с узлов заново
    try {
      c.last_p = prevLast && prevLast.last_cid === c.last_cid && prevLast.last_hash === c.last_hash && prevLast.last_p && !prevLast.last_p.missing
        ? prevLast.last_p
        : c.last_sender ? (await decryptMessage(lastMessageOf(c))).p : null;
    } catch (err) {
      console.warn('Ошибка предпросмотра чата', c.id, err);
      c.last_p = { missing: true };
    }
  }));
  if (state.me?.id !== me) return;
  await loadPeople(data.flatMap((c) => c.member_ids || []));
  if (state.me?.id !== me) return;
  state.chats = new Map(data.map((c) => [c.id, c]));
  if (state.activeId && !state.chats.has(state.activeId)) closeChat();   // чат удалили или нас из него убрали
  renderChats();
}

function previewText(p) {
  if (!p) return 'Зашифровано';
  if (p.missing) return 'Сообщение недоступно';
  if (p.bad) return 'Не удалось расшифровать';
  const t = p.t ? stripMarkdown(p.t) : p.t;
  if (p.v) return '🎤 Голосовое ' + fmtDur(p.v.dur) + (p.v.gone ? ' (удалено)' : '');
  if (p.call) return callLabel(p.call, null);
  if (p.st) return '🙂 Стикер «' + stickerLabel(p.st) + '»';
  if (p.file) return '📎 ' + p.file.name + (p.t ? ': ' + stripMarkdown(p.t) : '');
  if (p.img?.st) return '🙂 Стикер';
  return p.img ? 'Фото' + (t ? ': ' + t : '') : t;
}
function previewOf(c) {
  if (!c.last_sender) return isSaved(c) ? 'Заметки и сохранённое' : c.is_group ? (c.is_official ? 'Официальный чат' : 'Группа создана') : 'Новый чат';
  if (state.blocked.has(c.last_sender)) return 'Сообщение скрыто';
  const who = c.last_sender === state.me.id ? 'Вы: ' : c.is_group ? nameOf(c.last_sender) + ': ' : '';
  return who + previewText(c.last_p);
}

function renderChats() {
  const all = [...state.chats.values()].sort((a, b) =>
    (b.is_official - a.is_official) || (isSaved(b) - isSaved(a)) || ts(b.last_message_at) - ts(a.last_message_at));
  const archived = all.filter((c) => c.archived);
  if (state.showArchive && !archived.length) state.showArchive = false;
  const q = normSearch($('findInput').value.replace(/^@/, ''));
  const items = all.filter((c) => (q ? true : !!c.archived === state.showArchive)
    && (!q || normSearch(titleOf(c)).includes(q) || (!c.is_group && !isSaved(c) && normSearch(state.people.get(otherOf(c))?.username || '').includes(q))));
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
const AVATAR_SIZE = 640;
/** Окно обрезки: двигать пальцем/мышью, приближать щипком, колесом или ползунком. Возвращает JPEG или null. */
function cropDialog(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = h('img', { class: 'crop-img', alt: '', draggable: false });
    const view = h('div', { class: 'crop-view' }, img, h('div', { class: 'crop-mask' }));
    const zoom = h('input', { type: 'range', min: 1, max: 4, step: 0.01, value: 1, class: 'crop-zoom', 'aria-label': 'Приблизить' });
    let V = 0, W = 0, H = 0, base = 1, s = 1, x = 0, y = 0, done = false;
    const clamp = () => { x = Math.min(0, Math.max(V - W * s, x)); y = Math.min(0, Math.max(V - H * s, y)); };
    const draw = () => { clamp(); img.style.transform = `translate(${x}px, ${y}px) scale(${s})`; };
    const setScale = (next, cx = V / 2, cy = V / 2) => {
      next = Math.min(base * 4, Math.max(base, next));
      x = cx - ((cx - x) * next) / s; y = cy - ((cy - y) * next) / s; s = next;
      zoom.value = String(s / base); draw();
    };
    img.onload = () => {
      V = view.clientWidth; W = img.naturalWidth; H = img.naturalHeight;
      base = s = V / Math.min(W, H);
      x = (V - W * s) / 2; y = (V - H * s) / 2;
      img.style.width = W + 'px'; img.style.height = H + 'px';
      draw();
    };
    img.onerror = () => { finish(null); toast('Не получилось открыть картинку'); };
    zoom.oninput = () => setScale(base * +zoom.value);
    view.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = view.getBoundingClientRect();
      setScale(s * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    const pts = new Map();
    let last = null;
    view.addEventListener('pointerdown', (e) => { view.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); last = null; });
    view.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 1) { x += e.clientX - prev[0]; y += e.clientY - prev[1]; draw(); return; }
      const [a, b] = [...pts.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const r = view.getBoundingClientRect();
      if (last) setScale(s * (dist / last), (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
      last = dist;
    });
    const up = (e) => { pts.delete(e.pointerId); last = null; };
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);

    const finish = (blob) => { if (done) return; done = true; URL.revokeObjectURL(url); modalOnClose = null; closeModal(); resolve(blob); };
    const ok = h('button', { class: 'btn btn-primary btn-block', text: 'Готово', onclick: () => {
      const c = h('canvas', { width: AVATAR_SIZE, height: AVATAR_SIZE });
      const side = V / s;
      c.getContext('2d').drawImage(img, -x / s, -y / s, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      c.toBlob((b) => finish(b), 'image/jpeg', 0.85);
    } });
    openModal({ title: 'Обрезать фото', onClose: () => finish(null) },
      view,
      h('div', { class: 'crop-row' }, h('span', { class: 'muted', text: '−' }), zoom, h('span', { class: 'muted', text: '+' })),
      h('p', { class: 'muted crop-hint', text: 'Двигайте фото пальцем, приближайте щипком или ползунком' }),
      ok);
    img.src = url;
  });
}
async function setAvatarPhoto(file) {
  const me = state.me.id, p = state.people.get(me);
  const old = p.avatar_path;
  let path = null;
  if (file) {
    if (!file.type.startsWith('image/')) throw new Error('Нужна картинка');
    const blob = await cropDialog(file);
    if (!blob) return false;                              // передумали
    path = `${me}/${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')}.jpg`;
    const { error } = await sb.storage.from(AVATAR_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
    if (error) throw error;
  }
  const { error } = await sb.from('profiles').update({ avatar_path: path }).eq('id', me);
  if (error) { if (path) sb.storage.from(AVATAR_BUCKET).remove([path]); throw error; }
  p.avatar_path = path;
  cleanAvatarFolder(path, old);
  renderMe(); renderChats();
  if (state.activeId) { renderHeader(); renderMessages({ keepScroll: true }); }
}
function privacySection(msg) {
  const box = section('Приватность',
    h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('b', { text: 'Скрывать, когда я был в сети' }),
      h('small', { text: 'Другие увидят «был(а) недавно». Как в Telegram: тогда и вы не видите чужое время.' })),
      toggle(state.hideSeen, async (e) => {
        const want = e.target.checked;
        const { error } = await sb.rpc('set_hide_seen', { p_hidden: want });
        if (error) { e.target.checked = !want; return say(msg, humanError(error)); }
        state.hideSeen = want; loadSeen();
        say(msg, want ? 'Время визита скрыто' : 'Время визита видно друзьям', 'ok');
      })));
  box.hidden = true;                                       // показываем, только если база уже с update-9
  sb.rpc('seen_of', { p_ids: [state.me.id] }).then(({ data, error }) => {
    if (error) return;
    state.hideSeen = !!data?.[0]?.hidden;
    box.querySelector('input').checked = state.hideSeen;
    box.hidden = false;
  });
  return box;
}

/** Удалить из своей папки все старые аватарки, кроме текущей */
async function cleanAvatarFolder(keep, old) {
  const me = state.me.id;
  try {
    const { data } = await sb.storage.from(AVATAR_BUCKET).list(me, { limit: 100 });
    const extra = (data || []).map((f) => `${me}/${f.name}`).filter((n) => n !== keep);
    if (old && old !== keep && !extra.includes(old)) extra.push(old);
    if (extra.length) await sb.storage.from(AVATAR_BUCKET).remove(extra);
  } catch {}
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
    try {
      const changed = await setAvatarPhoto(f);            // окно обрезки заменяет настройки — потом открываем их снова
      openSettings();
      if (changed !== false) toast('Фото поставлено');
    } catch (e) { openSettings(); toast(humanError(e)); }
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
    if (m.p.st) { addMessage(await insertMessage(target, { st: m.p.st, f })); return toast('Сохранено в избранное'); }
    if (m.p.file) {
      const blob = await (await fetch(await fileBlobUrl(m))).blob();
      await sendFile(new File([blob], m.p.file.name, { type: m.p.file.mime || 'application/octet-stream' }), target, { f, t: m.p.t || '' });
      return toast('Сохранено в избранное');
    }
    if (m.p.v) {
      const blob = await voiceBlob(m);
      await sendVoice(blob, m.p.v.dur, m.p.v.w, target, { f });
      return toast('Сохранено в избранное');
    }
    if (m.p.img) {
      const src = state.images.get(m.p.img.path || m.p.img.hash);
      if (!src) return inlineError('Фото ещё не загрузилось — подождите секунду');
      const blob = await (await fetch(src)).blob();
      await sendImage(new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' }), target, { t: m.p.t || '', f }, { sticker: !!m.p.img.st });
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
  if (q === state.people.get(state.me.id).username) {      // свой ник — открываем «Избранное»
    $('findInput').value = ''; say('findMsg', '');
    return state.savedId ? openChat(state.savedId) : say('findMsg', 'Это же вы');
  }
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
  for (const b of ['searchBtn', 'callAudioBtn', 'callVideoBtn']) $(b).hidden = true;
  closeSearch(); closeStickers();
  if (rec) stopVoice(false);
  $('jumpDown')?.classList.remove('show');
}

function renderHeader() {
  const c = state.chats.get(state.activeId);
  if (!c) return;
  const canCall = !c.is_group && !isSaved(c) && !writeBlock(c) && !!window.RTCPeerConnection;
  $('callAudioBtn').hidden = !canCall;
  $('searchBtn').hidden = false;
  $('callVideoBtn').hidden = !canCall;
  $('chatTitle').replaceChildren(nameLine(titleOf(c), chatBadge(c)));
  $('chatAvatar').replaceChildren(chatAvatar(c, 'sm'));
  if (Date.now() < state.typing.until) {
    $('chatStatus').replaceChildren(h('span', { class: 'typing' }, c.is_group ? `${nameOf(state.typing.who)} печатает` : 'печатает',
      h('span', { class: 'typing-dots' }, h('i'), h('i'), h('i'))));
    return;
  }
  const n = (c.member_ids || []).length;
  const on = (c.member_ids || []).filter(isOnline).length;
  const members = `${n} ${plural(n, 'участник', 'участника', 'участников')}` + (on ? `, ${on} в сети` : '');
  const seen = !c.is_group && !isSaved(c) ? seenText(otherOf(c)) : null;
  $('chatStatus').replaceChildren(icon('lock'),
    isSaved(c) ? 'Только для вас: заметки и сохранённое'
      : c.is_group ? (c.is_official ? 'Официальный чат · ' + members : members)
      : seen ? h('span', { class: isOnline(otherOf(c)) ? 'online-text' : '', text: seen }) : nickOf(otherOf(c)));
}

function renderComposer() {
  syncMic();
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
  if (state.activeId === chatId && data) state.reads = new Map(data.map((r) => [r.user_id, r.last_read_at]));
}

async function openChat(id) {
  state.seen.delete(id);                                  // при открытии — без анимации каждого пузыря
  state.shown.delete(id);                                 // и снова только последние сообщения
  if (rec && rec.chat !== id) stopVoice(false);
  closeStickers();
  closeSearch();
  if (!state.chats.has(id)) await loadChats();
  if (!state.chats.has(id)) return;
  if (state.activeId !== id) { setCompose(null); state.reads = new Map(); }
  state.activeId = id;
  document.body.classList.add('in-chat');
  $('placeholder').hidden = true;
  $('messages').hidden = false;
  renderHeader();
  renderComposer();
  markRead(id);
  renderChats();
  joinTyping(id);
  loadReads(id).then(() => { if (state.activeId === id) patchTicks(); });

  if (!state.history.has(id)) {
    $('messages').replaceChildren(h('div', { class: 'day', text: 'Загрузка…' }));
    const { data, error } = await sb.from('messages').select(MSG_COLUMNS)
      .eq('conversation_id', id).order('created_at', { ascending: false }).limit(PAGE);
    if (error) { if (state.activeId === id) $('messages').replaceChildren(h('div', { class: 'inline-err', text: humanError(error) })); return; }
    const merged = new Map([...(state.history.get(id) || []), ...data].map((m) => [m.id, m]));
    state.history.set(id, [...merged.values()].sort(byTime));
    state.more.set(id, data.length === PAGE);
    await loadPeople(state.history.get(id).map((m) => m.sender_id));
  }
  await ensureChatKey(id).catch(() => false);
  await Promise.all((state.history.get(id) || []).map(decryptMessage));
  if (state.activeId !== id) return;
  renderMessages();
  loadReactions(id, (state.history.get(id) || []).map((m) => m.id));
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
  loadReactions(chatId, data.map((m) => m.id));
  const merged = new Map([...data, ...list].map((m) => [m.id, m]));
  state.history.set(chatId, [...merged.values()].sort(byTime));
  state.more.set(chatId, data.length === PAGE);
  state.shown.set(chatId, (state.shown.get(chatId) || RENDER_STEP) + data.length);
  if (state.activeId !== chatId) return;
  const box = $('messages');
  const fromBottom = box.scrollHeight - box.scrollTop;
  renderMessages({ keepScroll: true });
  box.scrollTop = box.scrollHeight - fromBottom;          // остаёмся на том же месте
}

const RENDER_STEP = 80;      // сколько сообщений рисуем сразу и добавляем по кнопке
/** Показать ещё n уже загруженных сообщений сверху, не сдвигая то, что на экране */
function showMore(chatId, n) {
  if (state.activeId !== chatId) return;
  state.shown.set(chatId, (state.shown.get(chatId) || RENDER_STEP) + n);
  const box = $('messages');
  const fromBottom = box.scrollHeight - box.scrollTop;
  renderMessages({ keepScroll: true });
  box.scrollTop = box.scrollHeight - fromBottom;
}
/** Сообщение есть в истории, но не нарисовано (выше окна) — расширить окно, чтобы оно появилось */
function ensureRendered(id) {
  if (msgEl(id)) return true;
  const all = state.history.get(state.activeId) || [];
  const i = all.findIndex((m) => String(m.id) === String(id));
  if (i === -1) return false;
  const need = all.length - i + 10;
  if (need > (state.shown.get(state.activeId) || RENDER_STEP)) { state.shown.set(state.activeId, need); renderMessages({ keepScroll: true }); }
  return !!msgEl(id);
}

const imgPool = new Map();   // ref -> уже загруженный <img> из прошлой отрисовки
const embedPool = new Map(); // id сообщения -> уже открытый плеер (не перезагружаем при перерисовке)
function renderMessages({ keepScroll = false, toBottom = false } = {}) {
  const box = $('messages');
  // Положение ленты запоминаем ДО того, как заберём из неё готовые фото и плееры: как только фото
  // уходит из ленты, браузер сам сдвигает прокрутку на его высоту, и лента «уезжала» вверх.
  const prevTop = box.scrollTop;
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150;
  imgPool.clear();
  embedPool.clear();
  for (const fr of box.querySelectorAll('.embed-open[data-mid]')) embedPool.set(fr.dataset.mid, fr);
  for (const im of box.querySelectorAll('img.msg-img[data-ref]')) if (im.src) imgPool.set(im.dataset.ref, im);
  const c = state.chats.get(state.activeId);
  const all = state.history.get(state.activeId) || [];
  // Рисуем не всю историю, а последние сообщения (окно растёт по кнопке): длинная лента открывается быстро
  const list = all.slice(-(state.shown.get(state.activeId) || RENDER_STEP));
  const hiddenOlder = all.length > list.length;
  const nodes = [];
  if (hiddenOlder || state.more.get(state.activeId)) {
    const chatId = state.activeId;
    const more = h('button', { class: 'btn load-more', type: 'button', text: 'Показать более ранние' });
    more.onclick = () => (hiddenOlder ? showMore(chatId, RENDER_STEP) : loadOlder(chatId, more));
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
  imgPool.clear();
  box.replaceChildren(...nodes);
  if (!$('searchBar').hidden && search.hits.length) requestAnimationFrame(() => { clearSearchMarks(); showHitQuiet(); });
  if (firstRender) {
    box.classList.remove('chat-enter'); void box.offsetWidth; box.classList.add('chat-enter');
    clearTimeout(box.enterT); box.enterT = setTimeout(() => box.classList.remove('chat-enter'), 450);
  }
  resolveImages(box);
  // Вниз — только при открытии чата, своём новом сообщении или если и так были внизу.
  // Иначе (читают, правят, пришла реакция, итог звонка) лента остаётся на месте.
  const stick = firstRender || toBottom || (!keepScroll && wasNearBottom);
  box.scrollTop = stick ? box.scrollHeight : prevTop;
  updateJumpDown();
}

/* Точечные обновления ленты: полная перерисовка 150+ пузырей на каждое сообщение заметно тормозила
   (на телефоне — до полсекунды на сообщение). Новое дорисовываем в конец, изменённое меняем на месте. */
const bubbleOpts = (m, prev) => {
  const c = state.chats.get(m.conversation_id);
  const sameDay = !!prev && dayOf(prev.created_at) === dayOf(m.created_at);
  const continued = sameDay && prev.sender_id === m.sender_id && ts(m.created_at) - ts(prev.created_at) < 5 * 60e3;
  return { sameDay, continued, showName: !!c?.is_group && m.sender_id !== state.me.id && !continued };
};
const msgEl = (id) => $('messages').querySelector(`.msg[data-id="${CSS.escape(String(id))}"]`);
/** Новое сообщение в конец ленты. Если оно не последнее или лента ещё не нарисована — рисуем целиком. */
function appendBubble(m, toBottom = false) {
  const box = $('messages');
  const list = state.history.get(state.activeId) || [];
  const i = list.indexOf(m), prev = list[i - 1];
  const seen = state.seen.get(state.activeId);
  const rendered = [...box.querySelectorAll('.msg[data-id]')].pop();
  if (i === -1 || i !== list.length - 1 || !seen || (prev ? rendered?.dataset.id !== String(prev.id) : !!rendered)) {
    return renderMessages({ toBottom });
  }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150;
  box.querySelector(':scope > .empty-chat')?.remove();
  const o = bubbleOpts(m, prev);
  if (!o.sameDay) box.append(h('div', { class: 'day', text: dayOf(m.created_at) }));
  const key = m.cid || m.id;
  const fresh = !seen.has(key);
  seen.add(key);
  state.shown.set(state.activeId, (state.shown.get(state.activeId) || RENDER_STEP) + 1);   // окно не «съезжает»
  const el = bubble(m, { showName: o.showName, continued: o.continued, fresh });
  box.append(el);
  resolveImages(el);
  if (toBottom || nearBottom) box.scrollTop = box.scrollHeight;
  updateJumpDown();
}
/** Заменить один пузырь (правка, итог звонка, автоочистка) — без перерисовки всей ленты */
function replaceBubble(m) {
  const box = $('messages');
  const list = state.history.get(state.activeId) || [];
  const i = list.findIndex((x) => x.id === m.id);
  const old = msgEl(m.id);
  if (i === -1 || !old) return renderMessages();
  const top = box.scrollTop;                                 // до переноса фото (см. renderMessages)
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150;
  imgPool.clear(); embedPool.clear();
  for (const im of old.querySelectorAll('img.msg-img[data-ref]')) if (im.src) imgPool.set(im.dataset.ref, im);
  for (const fr of old.querySelectorAll('.embed-open[data-mid]')) embedPool.set(fr.dataset.mid, fr);
  const o = bubbleOpts(m, list[i - 1]);
  const el = bubble(m, { showName: o.showName, continued: o.continued, fresh: false });
  imgPool.clear(); embedPool.clear();
  old.replaceWith(el);
  resolveImages(el);
  box.scrollTop = nearBottom ? box.scrollHeight : top;
  updateJumpDown();
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
    el.append(h('div', { class: 'msg-from', vars: { '--h': hueOfUser(m.sender_id) }, title: 'Открыть профиль',
      onclick: (e) => { e.stopPropagation(); openUserProfile(m.sender_id); } }, nameLine(nameOf(m.sender_id), roleBadge(m.sender_id))));
  }
  if (p?.f) el.append(h('div', { class: 'msg-fwd' }, icon('bookmark'), p.f.s === state.me.id ? 'Ваше сообщение' : 'От ' + (state.people.has(p.f.s) ? nameOf(p.f.s) : p.f.n || '…')));
  if (p?.r) {
    el.append(h('button', { class: 'msg-quote', type: 'button', onclick: () => jumpTo(p.r.id) },
      h('b', { text: nameOf(p.r.s) }), h('span', { text: p.r.t ? stripMarkdown(p.r.t) : p.r.v ? '🎤 Голосовое' : p.r.st ? '🙂 Стикер' : p.r.fn ? '📎 ' + p.r.fn : 'Фото' })));
  }
  if (p?.img?.gone) el.append(h('div', { class: 'media-gone' }, icon('attach'), p.img.st ? 'Стикер удалён через 30 дней' : 'Фото удалено через 30 дней, чтобы освободить место'));
  else if (p?.img) {
    // уже показанное фото переносим в новый пузырь как есть — чтобы оно не мигало при перерисовке
    const reused = imgPool.get(p.img.path || p.img.hash);
    if (reused) imgPool.delete(p.img.path || p.img.hash);
    const img = reused || h('img', { class: 'msg-img', alt: 'Фото', dataset: {
      ref: p.img.path || p.img.hash, path: p.img.path || '', hash: p.img.hash || '', nodes: (p.img.nodes || []).join(','),
      aad: p.img.a === 2 ? 'img|' + m.conversation_id : p.img.path, iv: p.img.iv, mime: p.img.mime || 'image/jpeg', chat: m.conversation_id,
      kv: p.img.kv || m.key_version || 1,
    } });
    if (p.img.w && p.img.h) img.style.aspectRatio = `${p.img.w} / ${p.img.h}`;
    img.onclick = () => img.src && openLightbox(img.src);
    el.append(img);
  }
  if (p?.v?.gone) el.append(h('div', { class: 'media-gone' }, icon('mic'), 'Голосовое ' + fmtDur(p.v.dur) + ' удалено через 30 дней'));
  else if (p?.v) { el.classList.add('voice'); el.append(voiceBubble(m)); }
  if (p?.call) { el.classList.add('call-msg'); el.append(callBubble(m)); }
  if (p?.file?.gone) el.append(h('div', { class: 'media-gone' }, icon('file'), `«${p.file.name}» удалён через 30 дней`));
  else if (p?.file) { el.classList.add('file-msg'); el.append(fileBubble(m)); }
  if (p?.st) {
    el.classList.add('sticker');
    const box = h('div', { class: 'sticker-art', title: stickerLabel(p.st), onclick: (e) => { e.stopPropagation(); box.classList.remove('boing'); void box.offsetWidth; box.classList.add('boing'); } });
    box.innerHTML = stickerSvg(p.st, 150);                // только наши нарисованные части
    el.append(box);
  }
  if (p?.img?.st && !p.img.gone) el.classList.add('sticker', 'sticker-img');
  const text = !p ? 'Сообщение ещё не расшифровано'
    : p.missing ? 'Сообщение сейчас недоступно: узлы сети не отвечают'
    : p.bad ? 'Не удалось расшифровать' : p.t;
  if (text) el.append(p?.t && text === p.t ? h('div', { class: 'msg-text md' }, renderMarkdown(text)) : h('div', { class: 'msg-text', text }));
  if (m.sigOk === false) el.append(h('div', { class: 'msg-forged' }, icon('warn'), 'Подпись не совпадает — возможна подделка'));

  const emb = p?.t && !p.bad ? findEmbed(p.t) : null;
  if (emb) el.append(embedCard(m, emb));
  const rx = reactionChips(m);
  if (rx) el.append(rx);
  const meta = h('span', { class: 'msg-meta' });
  if (m.edited_at && !p?.call && !p?.img?.gone && !p?.v?.gone) meta.append(h('span', { text: 'изменено' }));
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

/** Обновить только галочки прочтения — без перерисовки ленты */
function patchTicks() {
  const box = $('messages');
  const byId = new Map((state.history.get(state.activeId) || []).map((m) => [String(m.id), m]));
  for (const el of box.querySelectorAll('.msg.mine[data-id]')) {
    const m = byId.get(el.dataset.id), t = el.querySelector(':scope > .msg-meta .ticks');
    if (!m || !t) continue;
    const read = isReadByOthers(m);
    if (t.classList.contains('read') === read) continue;
    t.classList.toggle('read', read);
    t.textContent = read ? '✓✓' : '✓';
    t.title = read ? 'Прочитано' : 'Отправлено';
  }
}

/** Кнопка «вниз», когда пролистал вверх */
function updateJumpDown() {
  const box = $('messages');
  let btn = $('jumpDown');
  if (!btn) {
    btn = h('button', { type: 'button', id: 'jumpDown', class: 'jump-down', title: 'Вниз', onclick: () => box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }) }, icon('back'));
    box.parentElement.append(btn);
    box.addEventListener('scroll', updateJumpDown, { passive: true });
  }
  btn.classList.toggle('show', !box.hidden && box.scrollHeight - box.scrollTop - box.clientHeight > 400);
}
function jumpTo(id) {
  if (!ensureRendered(id)) return;
  const el = msgEl(id);
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
  if (state.savedId && m.conversation_id !== state.savedId && !m.p.img?.gone && !m.p.v?.gone && !m.p.file?.gone) items.push(['bookmark', 'В избранное', () => saveToFavorites(m)]);
  if (m.p.img?.st && !m.p.img.gone) items.push(['smile', 'В мои стикеры', () => saveCustomSticker(m)]);
  if (mine && !m.p.img && !m.p.v && !m.p.call && !m.p.st && !m.p.file && c && !writeBlock(c)) items.push(['edit', 'Изменить', () => setCompose({ mode: 'edit', msg: m })]);
  if (mine) items.push(['trash', 'Удалить у всех', () => deleteMessage(m), 'danger']);
  const canReact = !!c && /^\d+$/.test(String(m.id)) && !(!c.is_group && state.blocked.has(otherOf(c)));
  if (!items.length && !canReact) return;
  const mineNow = state.reactions.get(m.id)?.get(state.me.id);
  const bar = canReact ? h('div', { class: 'menu-react' }, ...QUICK_REACTIONS.map((e) => h('button', {
    type: 'button', class: e === mineNow ? 'on' : '', text: e, title: e, onclick: () => { closeMenu(); react(m, e); } }))) : null;
  const menu = h('div', { class: 'menu', role: 'menu' }, bar, ...items.map(([ic, label, fn, cls]) =>
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
  // сначала само сообщение: если база откажет, вложения должны остаться на месте
  const { error } = await sb.from('messages').delete().eq('id', m.id);
  if (error) return inlineError('Не удалилось: ' + humanError(error));
  removeMessage(m.id);
  if (m.nodes?.length && m.ct_hash) net.del(m.nodes, `${m.conversation_id}/${m.ct_hash}`);
  for (const media of [m.p?.img, m.p?.v, m.p?.file]) dropMedia(m.conversation_id, media);
}
/** Убрать вложение (фото, голосовое, файл) с узлов или из хранилища центра. true — получилось или нечего убирать. */
async function dropMedia(chatId, media) {
  if (!media || media.gone) return true;
  if (media.hash && media.nodes?.length) { await net.del(media.nodes, `${chatId}/${media.hash}`).catch(() => {}); return true; }
  if (media.path) {                                        // старый способ: файл в хранилище центра (удалить можно после update-12)
    const { data, error } = await sb.storage.from(BUCKET).remove([media.path]).catch((e) => ({ error: e }));
    return !error && !!data?.length;
  }
  return true;
}

function removeMessage(id) {
  state.reactions.delete(id);
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
  // Сообщения нет в загруженных историях. Сервер присылает такие события про ЛЮБЫЕ удаления
  // (без подробностей), поэтому не дёргаем список на каждое — раз в несколько секунд, не чаще.
  clearTimeout(removeMessage.t);
  removeMessage.t = setTimeout(() => { if (state.me) loadChats(); }, 4000);
}

/* ---------- Ответ / изменение ---------- */
function setCompose(next) {
  const wasEdit = state.compose?.mode === 'edit';
  state.compose = next;
  queueMicrotask(syncMic);
  if (!next) {
    $('composeBar').hidden = true;
    if (wasEdit) { textArea.value = ''; autosize(); }
    return;
  }
  const p = next.msg.p;
  setIcon($('composeBar'), next.mode === 'edit' ? 'edit' : 'reply');
  $('composeTitle').textContent = next.mode === 'edit' ? 'Изменение' : 'Ответ ' + nameOf(next.msg.sender_id);
  $('composeText').textContent = p.t ? stripMarkdown(p.t) : p.v ? '🎤 Голосовое' : p.st || p.img?.st ? '🙂 Стикер' : p.file ? '📎 ' + p.file.name : 'Фото';
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

function openLightbox(src, round = false) {
  const lb = h('div', { class: 'lightbox', onclick: () => lb.remove() }, h('img', { src, alt: '', class: round ? 'round' : '' }));
  document.body.append(lb);
}
/** Большая аватарка: нажать — посмотреть фото целиком */
function zoomAvatar(el, id) {
  const src = photoOf(id);
  if (!src) return el;
  el.classList.add('zoomable');
  el.title = 'Посмотреть фото';
  el.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(src, true); });
  return el;
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
  syncMic();
}
textArea.addEventListener('input', () => { autosize(); if (textArea.value) sendTyping(); syncMic(); });
/** Пустое поле — показываем микрофон, есть текст — кнопку «Отправить» */
function syncMic() {
  const voice = !textArea.value.trim() && state.compose?.mode !== 'edit' && !!window.MediaRecorder;
  $('composer').classList.toggle('can-voice', voice);
}
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
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) f.type.startsWith('image/') ? sendImage(f) : sendFile(f);
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
  if (error) {
    if (row.nodes) net.del(row.nodes, `${chatId}/${row.ct_hash}`);   // шифр уже лёг на узлы — убираем, раз сообщения не будет
    if (!retried && isRlsError(error) && (await refreshKeyVersion(chatId))) return insertMessage(chatId, payload, true);
    throw error;
  }
  data.p = payload;
  data.sigOk = row.sig ? true : null;
  return data;
}

/** Цитата для ответа: кто, что (коротко) и id исходного сообщения — всё внутри шифра */
function replyRef() {
  if (state.compose?.mode !== 'reply') return undefined;
  const m = state.compose.msg;
  return { id: m.id, s: m.sender_id, t: (m.p.t || (m.p.st || m.p.img?.st ? '' : m.p.img ? 'Фото' : '')).slice(0, 120), v: m.p.v ? 1 : undefined, st: m.p.st || m.p.img?.st ? 1 : undefined, fn: m.p.file ? m.p.file.name.slice(0, 80) : undefined };
}

async function editMessage(m, newText) { return updatePayload(m, { ...m.p, t: newText }); }
async function updatePayload(m, payload, retried = false) {
  const row = await sealMessage(m.conversation_id, payload, m.cid || uuid());
  delete row.cid;                                         // id сообщения при правке не меняется
  const oldKey = m.nodes?.length && m.ct_hash ? [m.nodes, `${m.conversation_id}/${m.ct_hash}`] : null;
  const { data, error } = await sb.from('messages').update(row).eq('id', m.id).select(MSG_COLUMNS).single();
  if (error) {
    if (row.nodes) net.del(row.nodes, `${m.conversation_id}/${row.ct_hash}`);
    if (!retried && isRlsError(error) && (await refreshKeyVersion(m.conversation_id))) return updatePayload(m, payload, true);
    throw error;
  }
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
  if (!content || !chatId) return;
  // Сразу забираем текст из поля: повторный Enter, пока идёт отправка, не пошлёт его второй раз
  const compose = state.compose;
  const payload = { t: content, r: replyRef() };
  textArea.value = '';
  autosize();
  setCompose(null);
  /** Не отправилось — вернуть текст в поле (если человек ещё в этом чате и ничего нового не набрал) */
  const restore = () => {
    if (state.activeId !== chatId || textArea.value) return;
    if (compose) setCompose(compose);
    textArea.value = content; autosize();
  };
  if (compose?.mode === 'edit' && compose.msg.p?.t === content) return;   // текст не поменялся — нечего сохранять
  if (!(await canSend(chatId))) return restore();
  try {
    if (compose?.mode === 'edit') await editMessage(compose.msg, content);
    else addMessage(await insertMessage(chatId, payload));
  } catch (err) {
    restore();
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
  const all = [...$('fileInput').files];
  $('fileInput').value = '';
  if (!all.length) return;
  const isPhoto = (f) => /^image\/(jpeg|png|webp|gif|heic|heif|avif)$/.test(f.type);
  for (const f of all.filter((f) => !isPhoto(f))) await sendFile(f);
  const files = all.filter(isPhoto);
  if (!files.length) return;
  if (!hasPlus() && files.length > 1) inlineError('Альбомы до 10 фото — с Плюсом. Отправляю первое фото.');
  const list = hasPlus() ? files.slice(0, ALBUM_MAX) : files.slice(0, 1);
  for (const f of list) await sendImage(f);
};

async function sendImage(file, target = null, extra = null, opts = {}) {
  const chatId = target || state.activeId;
  if (!chatId) return;
  if (!file.type.startsWith('image/')) return inlineError('Можно отправлять только картинки');
  if (!(await canSend(chatId))) return;
  // подпись — текст из поля (кроме стикеров и режима правки); поле очищаем сразу, чтобы набранное дальше не пропало
  const takeCaption = !extra && !opts.sticker && state.compose?.mode !== 'edit' && chatId === state.activeId;
  const caption = extra ? (extra.t || '') : takeCaption ? textArea.value.trim() : '';
  if (takeCaption && caption) { textArea.value = ''; autosize(); }
  $('uploading').hidden = false;
  let uploadedNodes = [], uploadedKey = null;
  try {
    const { blob, type, w, h: height } = opts.sticker ? await stickerImage(file) : await shrinkImage(file);
    if (blob.size > 6 * 1024 * 1024) throw new Error('Картинка слишком большая');
    const kv = currentVersion(chatId);
    const sealed = await E2E.sealBytes(chatKey(chatId, kv), await blob.arrayBuffer(), 'img|' + chatId);
    const bytes = new Uint8Array(sealed.data);
    const hash = await E2E.sha256hex(bytes);
    uploadedKey = `${chatId}/${hash}`;
    const img = { iv: sealed.iv, mime: type, w, h: height, a: 2, hash, kv };
    if (opts.sticker) img.st = 1;
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
    if (!extra && state.compose?.mode === 'reply') setCompose(null);
    addMessage(msg);
  } catch (err) {
    if (uploadedNodes.length && uploadedKey) net.del(uploadedNodes, uploadedKey);   // не оставляем фото без сообщения
    if (takeCaption && caption && !textArea.value) { textArea.value = caption; autosize(); }
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
   Файлы: любые до 5 МБ, шифруются и хранятся у партнёров, как фото
   ===================================================================== */
const FILE_MAX = 5 * 1024 * 1024;
const fmtSize = (n) => (n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0).replace('.', ',') + ' КБ' : (n / 1048576).toFixed(1).replace('.', ',') + ' МБ');
function fileKind(name, mime) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return ['PDF', 0];
  if (['doc', 'docx', 'odt', 'rtf', 'txt', 'md'].includes(ext)) return ['DOC', 220];
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return ['XLS', 140];
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return ['PPT', 25];
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return ['ZIP', 45];
  if (/^audio\//.test(mime) || ['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return ['♪', 280];
  if (/^video\//.test(mime) || ['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return ['▶', 320];
  if (['apk', 'exe', 'msi', 'dmg'].includes(ext)) return ['APP', 0];
  return [(ext || 'FILE').slice(0, 4).toUpperCase(), 230];
}
async function sendFile(file, target = null, extra = null) {
  const chatId = target || state.activeId;
  if (!chatId) return;
  if (file.size > FILE_MAX) return inlineError(`«${file.name}» больше 5 МБ — так много места у партнёров нет`);
  if (!file.size) return inlineError(`«${file.name}» пустой`);
  if (!(await canSend(chatId))) return;
  $('uploading').hidden = false;
  let uploadedNodes = [], key = null;
  try {
    const kv = currentVersion(chatId);
    const sealed = await E2E.sealBytes(chatKey(chatId, kv), await file.arrayBuffer(), 'file|' + chatId);
    const bytes = new Uint8Array(sealed.data);
    const hash = await E2E.sha256hex(bytes);
    key = `${chatId}/${hash}`;
    const meta = { name: String(file.name || 'файл').slice(0, 120), size: file.size, mime: file.type || 'application/octet-stream', iv: sealed.iv, hash, kv };
    const nodes = await net.put(key, bytes).catch(() => []);
    uploadedNodes = nodes;
    if (nodes.length) meta.nodes = nodes;
    else {
      meta.path = `${chatId}/${uuid()}.bin`;
      const { error } = await sb.storage.from(BUCKET).upload(meta.path, new Blob([bytes], { type: 'application/octet-stream' }), { contentType: 'application/octet-stream' });
      if (error) throw error;
    }
    state.images.set('f:' + (meta.path || hash), URL.createObjectURL(file));
    const caption = extra ? extra.t || '' : '';
    const msg = await insertMessage(chatId, extra ? { file: meta, t: caption, f: extra.f } : { file: meta, r: replyRef() });
    if (!extra && state.compose?.mode === 'reply') setCompose(null);
    addMessage(msg);
  } catch (err) {
    if (uploadedNodes.length && key) net.del(uploadedNodes, key);
    inlineError(sendError(err).replace('Не отправилось', `«${file.name}» не отправился`));
  } finally {
    $('uploading').hidden = true;
  }
}
async function fileBlobUrl(m) {
  const fl = m.p.file, ref = 'f:' + (fl.path || fl.hash);
  if (state.images.has(ref)) return state.images.get(ref);
  const key = chatKey(m.conversation_id, fl.kv || m.key_version || 1);
  if (!key) throw new Error('нет ключа');
  let cipher;
  if (fl.path) {
    const { data, error } = await sb.storage.from(BUCKET).download(fl.path);
    if (error) throw error;
    cipher = await data.arrayBuffer();
  } else {
    cipher = await net.get(fl.nodes || [], `${m.conversation_id}/${fl.hash}`, fl.hash);
    if (!cipher) throw new Error('missing');
  }
  const plain = await E2E.openBytes(key, cipher, fl.iv, 'file|' + m.conversation_id);
  const url = URL.createObjectURL(new Blob([plain], { type: fl.mime || 'application/octet-stream' }));
  state.images.set(ref, url);
  return url;
}
function fileBubble(m) {
  const fl = m.p.file;
  const [label, hue] = fileKind(fl.name, fl.mime);
  const status = h('small', { text: fmtSize(fl.size) });
  const open = async (e) => {
    e.stopPropagation();
    status.textContent = 'Расшифровываю…';
    try {
      const url = await fileBlobUrl(m);
      const a = h('a', { href: url, download: fl.name });
      document.body.append(a); a.click(); a.remove();
      status.textContent = fmtSize(fl.size) + ' · скачано';
    } catch (err) {
      status.textContent = /missing/.test(err?.message) ? 'Сейчас недоступен: узлы сети не отвечают' : 'Не получилось скачать';
    }
  };
  return h('button', { type: 'button', class: 'file-box', title: 'Скачать ' + fl.name, onclick: open },
    h('span', { class: 'file-ic', vars: { '--h': hue } }, h('b', { text: label })),
    h('span', { class: 'row-text' }, h('b', { class: 'file-name', text: fl.name }), status),
    h('span', { class: 'file-dl' }, icon('download')));
}
// файл, брошенный мимо чата, браузер открыл бы вместо мессенджера — не даём
addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
addEventListener('drop', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
// перетащить файлы в чат (на компьютере)
(() => {
  const zone = $('messages').parentElement;
  let depth = 0;
  zone.addEventListener('dragenter', (e) => { if (!state.activeId || !e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); depth++; zone.classList.add('dropping'); });
  zone.addEventListener('dragover', (e) => { if (state.activeId && e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('dropping'); } });
  zone.addEventListener('drop', async (e) => {
    if (!state.activeId) return;
    e.preventDefault(); depth = 0; zone.classList.remove('dropping');
    for (const f of [...(e.dataTransfer?.files || [])]) await (/^image\/(jpeg|png|webp|gif)$/.test(f.type) ? sendImage(f) : sendFile(f));
  });
})();

/* =====================================================================
   Поиск. Идёт прямо на устройстве: сервер не видит текст, искать там нечего.
   ===================================================================== */
const normSearch = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
$('findInput').addEventListener('input', () => renderChats());
const search = { hits: [], i: -1, q: '' };
function msgSearchText(m) {
  const p = m.p;
  if (!p || p.bad || p.missing) return '';
  return normSearch([p.t ? stripMarkdown(p.t) : '', p.st ? stickerLabel(p.st) : '', p.file?.name || ''].join(' '));
}
function openSearch() {
  $('searchBar').hidden = false;
  $('searchInput').value = search.q || '';
  $('searchInput').focus();
  runSearch();
}
function closeSearch() {
  $('searchBar').hidden = true;
  search.hits = []; search.i = -1;
  clearSearchMarks();
  $('searchCount').textContent = '';
}
function clearSearchMarks() {
  try { CSS.highlights?.delete('search'); } catch {}
  for (const el of $('messages').querySelectorAll('.msg.search-hit')) el.classList.remove('search-hit', 'search-cur');
}
function runSearch(keepIndex = false) {
  const q = normSearch($('searchInput').value);
  search.q = $('searchInput').value;
  clearSearchMarks();
  if (q.length < 2) { search.hits = []; search.i = -1; $('searchCount').textContent = q ? 'от 2 букв' : ''; return; }
  const list = state.history.get(state.activeId) || [];
  const prevId = search.hits[search.i];
  search.hits = list.filter((m) => msgSearchText(m).includes(q)).map((m) => m.id);
  if (!search.hits.length) {
    search.i = -1;
    $('searchCount').replaceChildren(state.more.get(state.activeId)
      ? h('button', { type: 'button', class: 'link-btn', text: 'Не найдено · искать в старых', onclick: searchDeeper })
      : 'Не найдено');
    return;
  }
  search.i = keepIndex && search.hits.includes(prevId) ? search.hits.indexOf(prevId) : search.hits.length - 1;   // начинаем с самого нового
  showHit();
}
function showHit() {
  if (search.hits[search.i] != null) ensureRendered(search.hits[search.i]);
  const n = search.hits.length;
  $('searchCount').replaceChildren(`${search.i + 1} из ${n}`,
    state.more.get(state.activeId) ? h('button', { type: 'button', class: 'link-btn', text: ' · ещё', title: 'Искать в старых сообщениях', onclick: searchDeeper }) : '');
  const box = $('messages');
  const q = normSearch($('searchInput').value);
  const ranges = [];
  for (const id of search.hits) {
    const el = box.querySelector(`.msg[data-id="${CSS.escape(String(id))}"]`);
    if (!el) continue;
    el.classList.add('search-hit');
    // подсветка самих слов (где браузер умеет CSS Highlight)
    if (window.Highlight && CSS.highlights) {
      const walker = document.createTreeWalker(el.querySelector('.msg-text') || el, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        const text = node.data.toLowerCase().replace(/ё/g, 'е');
        for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) {
          const r = new Range(); r.setStart(node, at); r.setEnd(node, at + q.length); ranges.push(r);
        }
      }
    }
  }
  try { if (ranges.length) CSS.highlights.set('search', new Highlight(...ranges)); } catch {}
  const cur = box.querySelector(`.msg[data-id="${CSS.escape(String(search.hits[search.i]))}"]`);
  if (cur) { cur.classList.add('search-cur'); cur.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}
/** После перерисовки ленты вернуть подсветку, не прокручивая */
function showHitQuiet() {
  const box = $('messages');
  for (const id of search.hits) box.querySelector(`.msg[data-id="${CSS.escape(String(id))}"]`)?.classList.add('search-hit');
  box.querySelector(`.msg[data-id="${CSS.escape(String(search.hits[search.i]))}"]`)?.classList.add('search-cur');
}
function stepSearch(dir) {
  if (!search.hits.length) return;
  search.i = (search.i + dir + search.hits.length) % search.hits.length;
  for (const el of $('messages').querySelectorAll('.msg.search-cur')) el.classList.remove('search-cur');
  showHit();
}
/** Догрузить старые сообщения (до 10 страниц) и искать снова */
async function searchDeeper() {
  const chatId = state.activeId;
  $('searchCount').textContent = 'Ищу в старых…';
  for (let k = 0; k < 10 && state.more.get(chatId) && state.activeId === chatId; k++) {
    const btn = h('button');
    await loadOlder(chatId, btn);
    const q = normSearch($('searchInput').value);
    if ((state.history.get(chatId) || []).some((m) => msgSearchText(m).includes(q))) break;
  }
  if (state.activeId === chatId) runSearch(true);
}
let searchTimer = null;
$('searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(), 150); });
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); stepSearch(e.shiftKey ? 1 : -1); }
  if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); }
});
$('searchUp').onclick = () => stepSearch(-1);
$('searchDown').onclick = () => stepSearch(1);
$('searchClose').onclick = closeSearch;
$('searchBtn').onclick = () => ($('searchBar').hidden ? openSearch() : closeSearch());
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && state.activeId && !$('modalRoot').children.length) { e.preventDefault(); openSearch(); }
});

/* =====================================================================
   Реакции. Эмодзи шифруется ключом чата — сервер не знает, чем отреагировали.
   ===================================================================== */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const reactAad = (msgId, uid) => `react|${msgId}|${uid}`;
async function decodeReaction(r) {
  if (!chatKey(r.conversation_id, r.kv)) await loadChatKeys();
  const v = await E2E.openJson(chatKey(r.conversation_id, r.kv), r.ct, r.iv, reactAad(r.message_id, r.user_id));
  return v && !v.bad && typeof v.e === 'string' && v.e.length <= 16 ? v.e : null;
}
/** Карточка плеера: по нажатию превращается в плеер сервиса */
function embedCard(m, emb) {
  const reused = embedPool.get(String(m.id));
  if (reused) { embedPool.delete(String(m.id)); return reused; }
  const card = h('button', { type: 'button', class: 'embed-card', vars: { '--svc': emb.color }, title: 'Открыть плеер ' + emb.service },
    h('span', { class: 'embed-play' }, icon('play')),
    h('span', { class: 'row-text' }, h('b', { text: emb.service }), h('small', { text: (emb.kind ? emb.kind[0].toUpperCase() + emb.kind.slice(1) : 'Ссылка') + (emb.kind === 'видео' ? ' · смотреть здесь' : ' · слушать здесь') })));
  card.onclick = (e) => {
    e.stopPropagation();
    const frame = h('iframe', { src: emb.src, loading: 'lazy', title: emb.service, allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
      referrerpolicy: 'no-referrer', allowfullscreen: true });
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation');
    if (emb.height) frame.style.height = emb.height + 'px';
    if (emb.ratio) frame.style.aspectRatio = emb.ratio;
    const wrap = h('div', { class: 'embed-open', dataset: { mid: String(m.id) } }, frame);
    card.replaceWith(wrap);
  };
  return card;
}

/** Обновить реакции только у одного сообщения, не трогая ленту (иначе прыгает прокрутка) */
function patchReactions(msgId) {
  const box = $('messages');
  const el = box.querySelector(`.msg[data-id="${CSS.escape(String(msgId))}"]`);
  if (!el) return;
  const m = (state.history.get(state.activeId) || []).find((x) => x.id === msgId);
  if (!m) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const cur = el.querySelector(':scope > .reactions');
  const had = new Set([...(cur?.querySelectorAll('.rx-e') || [])].map((x) => x.textContent));
  const next = reactionChips(m);
  const sig = (x) => (x ? [...x.querySelectorAll('.rx')].map((c) => c.className.replace(/\s*rx-new/, '') + c.textContent).join('|') : '');
  if (sig(cur) === sig(next)) return;                      // ничего не поменялось (например, сервер подтвердил нашу же реакцию)
  for (const chip of next?.querySelectorAll('.rx') || []) if (!had.has(chip.querySelector('.rx-e').textContent)) chip.classList.add('rx-new');   // анимируем только новую
  if (cur && next) cur.replaceWith(next);
  else if (cur) cur.remove();
  else if (next) el.insertBefore(next, el.querySelector(':scope > .msg-meta'));
  if (atBottom) box.scrollTop = box.scrollHeight;          // внизу ленты — остаёмся внизу
}
function setReaction(msgId, uid, emoji) {
  let mp = state.reactions.get(msgId);
  if (!mp) state.reactions.set(msgId, (mp = new Map()));
  if (emoji) mp.set(uid, emoji); else mp.delete(uid);
}
async function loadReactions(chatId, ids) {
  ids = ids.filter((x) => /^\d+$/.test(String(x)));
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await sb.from('reactions').select('message_id, conversation_id, user_id, ct, iv, kv')
      .eq('conversation_id', chatId).in('message_id', ids.slice(i, i + 150));
    if (error) return;                                     // база ещё без update-10
    for (const r of data || []) { setReaction(r.message_id, r.user_id, await decodeReaction(r)); if (state.activeId === chatId) patchReactions(r.message_id); }
  }
}
async function onReactionChange(p) {
  const r = p.eventType === 'DELETE' ? p.old : p.new;
  if (!r?.message_id) return;
  if (p.eventType === 'DELETE') {                         // приходят про все реакции подряд — берём только известные
    if (!state.reactions.get(r.message_id)?.has(r.user_id)) return;
    setReaction(r.message_id, r.user_id, null);
  }
  else setReaction(r.message_id, r.user_id, await decodeReaction(r));
  patchReactions(r.message_id);
}
async function react(m, emoji) {
  const me = state.me.id, chatId = m.conversation_id;
  const prev = state.reactions.get(m.id)?.get(me) || null;
  const next = prev === emoji ? null : emoji;
  setReaction(m.id, me, next);                             // сразу показываем, не дожидаясь сервера
  patchReactions(m.id);
  if (next) navigator.vibrate?.(10);
  try {
    if (!next) {
      const { error } = await sb.from('reactions').delete().eq('message_id', m.id).eq('user_id', me);
      if (error) throw error;
    } else {
      const kv = currentVersion(chatId);
      const { ct, iv } = await E2E.sealJson(chatKey(chatId, kv), { e: next }, reactAad(m.id, me));
      const { error } = await sb.from('reactions').upsert({ message_id: m.id, conversation_id: chatId, user_id: me, ct, iv, kv }, { onConflict: 'message_id,user_id' });
      if (error) throw error;
    }
  } catch (err) {
    setReaction(m.id, me, prev);
    patchReactions(m.id);
    toast(/reactions|relation|does not exist/i.test(err.message || '') ? 'Реакции заработают после обновления базы' : humanError(err));
  }
}
function reactionChips(m) {
  const mp = state.reactions.get(m.id);
  if (!mp || !mp.size) return null;
  const counts = new Map();
  for (const [uid, e] of mp) { if (!counts.has(e)) counts.set(e, []); counts.get(e).push(uid); }
  const mine = mp.get(state.me.id);
  return h('div', { class: 'reactions' }, ...[...counts].sort((a, b) => b[1].length - a[1].length).map(([e, who]) =>
    h('button', { type: 'button', class: 'rx' + (e === mine ? ' mine' : ''), title: who.map(nameOf).join(', '),
      onclick: (ev) => { ev.stopPropagation(); react(m, e); } }, h('span', { class: 'rx-e', text: e }), who.length > 1 ? h('span', { class: 'rx-n', text: String(who.length) }) : null)));
}
// двойной клик / двойное касание по сообщению — ❤️
let lastTap = { id: null, t: 0 };
$('messages').addEventListener('dblclick', (e) => {
  const el = e.target.closest('.msg[data-id]');
  if (!el || e.target.closest('button, a, img, .voice-box, .sticker-art')) return;
  const m = (state.history.get(state.activeId) || []).find((x) => String(x.id) === el.dataset.id);
  if (m?.p && !m.p.bad) { window.getSelection?.()?.removeAllRanges(); react(m, '❤️'); }
});
$('messages').addEventListener('touchend', (e) => {
  const el = e.target.closest('.msg[data-id]');
  if (!el || e.target.closest('button, a, img, .voice-box, .sticker-art')) return;
  const now = Date.now();
  if (lastTap.id === el.dataset.id && now - lastTap.t < 320) {
    const m = (state.history.get(state.activeId) || []).find((x) => String(x.id) === el.dataset.id);
    if (m?.p && !m.p.bad) { e.preventDefault(); react(m, '❤️'); }
    lastTap = { id: null, t: 0 };
  } else lastTap = { id: el.dataset.id, t: now };
}, { passive: false });

/* =====================================================================
   Автоочистка: свои фото и голосовые старше 30 дней убираем с узлов партнёров
   (у каждого узла всего 1 ГБ). Текст остаётся навсегда, «Избранное» не трогаем.
   ===================================================================== */
const MEDIA_TTL_DAYS = 30;
let cleaning = false;
async function cleanupOldMedia() {
  if (cleaning || !state.me || !state.savedId) return;     // ждём, пока узнаем «Избранное», чтобы его не тронуть
  cleaning = true;
  const me = state.me.id, cursorKey = 'cleanup-cursor-' + me;
  const cutoff = new Date(Date.now() - MEDIA_TTL_DAYS * 864e5).toISOString();
  let cursor = localStorage.getItem(cursorKey) || '1970-01-01T00:00:00Z';
  let cleaned = 0;
  try {
    for (let page = 0; page < 5; page++) {                  // не больше 500 сообщений за раз
      const { data, error } = await sb.from('messages').select(MSG_COLUMNS)
        .eq('sender_id', me).gt('created_at', cursor).lt('created_at', cutoff)
        .order('created_at', { ascending: true }).limit(100);
      if (error || !data?.length) break;
      for (const m of data) {
        cursor = m.created_at;
        if (m.conversation_id === state.savedId) continue;
        if (!chatKey(m.conversation_id, m.key_version)) continue;
        await decryptMessage(m).catch(() => {});
        const p = m.p;
        if (!p || p.bad || p.missing) continue;
        const media = p.img && !p.img.gone ? ['img', p.img] : p.v && !p.v.gone ? ['v', p.v] : p.file && !p.file.gone ? ['file', p.file] : null;
        if (!media) continue;
        const [kind, obj] = media;
        if (!(await dropMedia(m.conversation_id, obj))) continue;   // файл в центре без update-12 удалить нельзя — не трогаем
        const gone = { gone: 1, w: obj.w, h: obj.h, dur: obj.dur, st: obj.st, name: obj.name, size: obj.size };
        await updatePayload(m, { ...p, [kind]: gone }).catch(() => {});
        cleaned++;
      }
      localStorage.setItem(cursorKey, cursor);
      if (data.length < 100) break;
    }
  } catch {}
  cleaning = false;
  localStorage.setItem('cleanup-at-' + me, String(Date.now()));
  return cleaned;
}
function scheduleCleanup() {
  const last = +localStorage.getItem('cleanup-at-' + state.me.id) || 0;
  if (Date.now() - last > 864e5) setTimeout(cleanupOldMedia, 30000);   // раз в сутки, через 30 с после запуска
}

/* =====================================================================
   Стикеры: свой набор «Точка» + стикеры из своих картинок
   ===================================================================== */
const MY_STICKERS = 'my-stickers';
let stickerTab = 'dot';
/** Картинка → стикер: до 512 px, прозрачность сохраняется (WebP, а где не умеют — PNG) */
async function stickerImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
  const canvas = h('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  let blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.9));
  if (!blob || blob.type !== 'image/webp') blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return { blob, type: blob.type, w: canvas.width, h: canvas.height };
}
async function myStickers() { try { return (await E2E.store.get(MY_STICKERS)) || []; } catch { return []; } }
async function addMySticker(blob) {
  const list = await myStickers();
  list.unshift({ id: uuid(), blob, at: Date.now() });
  await E2E.store.set(MY_STICKERS, list.slice(0, 60));
}
async function saveCustomSticker(m) {
  const src = state.images.get(m.p.img.path || m.p.img.hash);
  if (!src) return toast('Стикер ещё не загрузился');
  await addMySticker(await (await fetch(src)).blob());
  toast('Добавлено в «Мои стикеры»');
}
const recentStickers = () => { try { return JSON.parse(localStorage.getItem('recent-stickers') || '[]'); } catch { return []; } };
function pushRecent(id) {
  try { localStorage.setItem('recent-stickers', JSON.stringify([id, ...recentStickers().filter((x) => x !== id)].slice(0, 8))); } catch {}
}
async function sendSticker(id) {
  const chatId = state.activeId;
  if (!chatId || !(await canSend(chatId))) return;
  closeStickers();
  pushRecent(id);
  try { addMessage(await insertMessage(chatId, { st: id, r: replyRef() })); if (state.compose?.mode === 'reply') setCompose(null); }
  catch (err) { inlineError(sendError(err)); }
}
async function renderStickers() {
  const panel = $('stickerPanel');
  const tabs = h('div', { class: 'sticker-tabs' },
    h('button', { type: 'button', class: stickerTab === 'dot' ? 'on' : '', text: 'Точка', onclick: () => { stickerTab = 'dot'; renderStickers(); } }),
    h('button', { type: 'button', class: stickerTab === 'mine' ? 'on' : '', text: 'Мои', onclick: () => { stickerTab = 'mine'; renderStickers(); } }),
    h('button', { type: 'button', class: 'icon-btn sticker-close', title: 'Закрыть', onclick: closeStickers }, icon('close')));
  const grid = h('div', { class: 'sticker-grid' });
  if (stickerTab === 'dot') {
    const recent = recentStickers().filter((id) => STICKERS.some((s) => s[0] === id));
    const tile = (id, label) => {
      const b = h('button', { type: 'button', class: 'sticker-tile', title: label, onclick: () => sendSticker(id) });
      b.innerHTML = stickerSvg(id, 72);
      return b;
    };
    if (recent.length) grid.append(h('div', { class: 'sticker-sub', text: 'Недавние' }), ...recent.map((id) => tile(id, stickerLabel(id))), h('div', { class: 'sticker-sub', text: 'Все' }));
    grid.append(...STICKERS.map(([id, label]) => tile(id, label)));
  } else {
    const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
    input.onchange = async () => {
      const f = input.files[0]; input.value = '';
      if (!f) return;
      try {
        const { blob } = await stickerImage(f);
        await addMySticker(blob);
        renderStickers();
      } catch { toast('Не получилось сделать стикер из этой картинки'); }
    };
    grid.append(input, h('button', { type: 'button', class: 'sticker-tile sticker-add', title: 'Сделать стикер из картинки', onclick: () => input.click() }, icon('plus'), h('small', { text: 'Свой' })));
    for (const st of await myStickers()) {
      const url = URL.createObjectURL(st.blob);
      grid.append(h('button', { type: 'button', class: 'sticker-tile', title: 'Отправить (долгое нажатие — удалить)',
        onclick: async () => { closeStickers(); await sendImage(new File([st.blob], 'sticker', { type: st.blob.type }), null, null, { sticker: true }); },
        oncontextmenu: async (e) => {
          e.preventDefault();
          if (!confirm('Убрать стикер из «Моих»?')) return;
          await E2E.store.set(MY_STICKERS, (await myStickers()).filter((x) => x.id !== st.id));
          renderStickers();
        } }, h('img', { src: url, alt: '', draggable: false })));
    }
    grid.append(h('p', { class: 'muted sticker-hint', text: 'Совет: картинка с прозрачным фоном (PNG) выглядит как настоящий стикер. Чужой стикер можно сохранить: долгое нажатие на него → «В мои стикеры».' }));
  }
  panel.replaceChildren(tabs, grid);
}
function openStickers() { $('stickerPanel').hidden = false; $('stickerBtn').classList.add('on'); renderStickers(); }
function closeStickers() { $('stickerPanel').hidden = true; $('stickerBtn').classList.remove('on'); }
$('stickerBtn').onclick = () => ($('stickerPanel').hidden ? openStickers() : closeStickers());

/* =====================================================================
   Звонки 1 на 1 (WebRTC). Звук и видео идут напрямую между устройствами,
   шифруются самим WebRTC (DTLS-SRTP). Сигналы для соединения шифруются
   ключом личного чата — подделать звонок или подсмотреть их посторонний не может.
   ===================================================================== */
const ICE_SERVERS = CONFIG.ICE_SERVERS || DEFAULT_ICE_SERVERS;

/** Настраиваем свежие TURN credentials перед SDP. При отсутствии функции остаётся STUN. */
async function configureCallIce(cur) {
  try {
    const config = await loadIceConfiguration(sb, ICE_SERVERS, state.me.id);
    if (call !== cur || cur.pc.signalingState === 'closed') return;
    cur.turnAvailable = config.turnConfigured;
    cur.turnError = config.turnError;
    cur.pc.setConfiguration({ ...cur.pc.getConfiguration(), iceServers: config.iceServers });
  } catch (e) {
    if (call === cur) {
      cur.turnAvailable = hasTurn(ICE_SERVERS);
      cur.turnError = String(e?.message || e);
      console.warn('Настройка TURN недоступна, пробуем STUN', e);
    }
  }
}
const RING_TIMEOUT = 45000;
/** Камера в HD: при слабом интернете браузер сам снизит качество, не обрывая звонок */
const camConstraints = (facing = 'user') => ({ facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } });
const VIDEO_BITRATE = 2_500_000;
async function tuneSenders(pc) {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    try {
      sender.track.contentHint = 'detail';
      const prm = sender.getParameters();
      if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
      prm.encodings[0].maxBitrate = VIDEO_BITRATE;
      prm.encodings[0].maxFramerate = 30;
      prm.degradationPreference = 'maintain-resolution';   // лучше меньше кадров, чем мыло
      await sender.setParameters(prm);
    } catch {}
  }
}
let call = null;
let callInbox = null;
const callOut = new Map();
const seenSignals = new Set();

function startCallInbox() {
  if (callInbox) sb.removeChannel(callInbox);
  callInbox = sb.channel('call-' + state.me.id)
    .on('broadcast', { event: 'sig' }, ({ payload }) => onSignal(payload).catch((e) => console.warn('Ошибка обработки сигнала звонка', e)))
    .subscribe();
}
function stopCalls() {
  if (call) finishCall('cancel', { silent: true });
  if (callInbox) { sb.removeChannel(callInbox); callInbox = null; }
  for (const ch of callOut.values()) sb.removeChannel(ch);
  callOut.clear();
}
async function outChannel(uid) {
  let ch = callOut.get(uid);
  if (!ch) {
    ch = sb.channel('call-' + uid);
    callOut.set(uid, ch); // параллельные ICE-сигналы используют одну подписку
    ch.callReady = new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('Нет связи с сервером звонков')), 5000);
      ch.subscribe((st) => {
        if (st === 'SUBSCRIBED') { clearTimeout(timer); res(); }
        if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') {
          clearTimeout(timer); rej(new Error('Нет связи с сервером звонков'));
        }
      });
    });
  }
  try { await ch.callReady; return ch; }
  catch (e) {
    if (callOut.get(uid) === ch) { callOut.delete(uid); sb.removeChannel(ch); }
    throw e;
  }
}
async function sendSignal(conv, to, msg) {
  const kv = currentVersion(conv);
  const key = chatKey(conv, kv);
  if (!key) throw new Error('нет ключа');
  const sealed = await E2E.sealJson(key, { ...msg, dev: DEVICE, sid: uuid(), ts: Date.now() }, `call|${conv}|${state.me.id}`);
  const ch = await outChannel(to);
  const result = await ch.send({ type: 'broadcast', event: 'sig', payload: { from: state.me.id, conv, kv, ...sealed } });
  if (result !== 'ok') throw new Error('Не удалось отправить сигнал звонка: ' + String(result));
}
const DEVICE = uuid();                 // эта вкладка: чтобы отличать свои другие устройства
const endedCalls = new Set();          // завершённые звонки: их запоздавшие повторы offer не должны звонить снова
/** Сказать своим другим устройствам: этот входящий звонок уже обработан здесь */
async function tellMyDevices(conv, id) {
  const kv = currentVersion(conv), key = chatKey(conv, kv);
  if (!key || !callInbox) return;
  const sealed = await E2E.sealJson(key, { t: 'taken', id, dev: DEVICE, ts: Date.now() }, `call|${conv}|${state.me.id}`);
  await callInbox.send({ type: 'broadcast', event: 'sig', payload: { from: state.me.id, conv, kv, ...sealed } });
}
async function onSignal(env) {
  if (!env || !state.me) return;
  const self = env.from === state.me.id;
  const c = state.chats.get(env.conv);
  if (!c || c.is_group || (!self && otherOf(c) !== env.from)) return;   // только из своего личного чата
  if (!chatKey(env.conv, env.kv)) await loadChatKeys();
  const msg = await E2E.openJson(chatKey(env.conv, env.kv), env.ct, env.iv, `call|${env.conv}|${env.from}`);
  if (!msg || msg.bad || Math.abs(Date.now() - msg.ts) > 90000) return;
  if (self) {
    // на другом моём устройстве ответили или отклонили — здесь перестаём звонить
    if (msg.t === 'taken' && msg.dev !== DEVICE) {
      endedCalls.add(msg.id);
      if (call?.id === msg.id && call.dir === 'in' && !call.answered) finishCall('cancel', { remote: true, silent: true });
    }
    return;
  }
  const tag = msg.sid || JSON.stringify([msg.t, msg.id, msg.ts, msg.dev, msg.candidate]);
  if (seenSignals.has(tag)) return;
  seenSignals.add(tag);
  if (seenSignals.size > 500) seenSignals.clear();
  if (msg.t === 'offer') return endedCalls.has(msg.id) ? undefined : incomingOffer(env.conv, env.from, msg);
  if (!call || call.id !== msg.id || call.conv !== env.conv || call.peer !== env.from) return;
  if (msg.t === 'media') {
    if (msg.dev !== call.remoteDev || (call.remoteMediaTs || 0) > msg.ts) return;
    call.remoteMediaTs = msg.ts;
    call.remoteMedia = { screen: msg.screen === true, video: msg.video === true };
    updateCallUi();
    return;
  }
  if (msg.t === 'ice') {
    const cur = call;
    if (msg.candidate && (!cur.remoteDev || cur.remoteDev === msg.dev)) {
      (cur.remoteIceSeen ||= []).push(msg.candidate);
      if (cur.remoteIceSeen.length > 300) cur.remoteIceSeen.shift();
      (cur.pendingIce ||= []).push({ dev: msg.dev, candidate: msg.candidate, gen: msg.gen || 0 });
      await flushIce(cur);
    }
    return;
  }
  if (msg.t === 'restart-request') {
    if (call.dir === 'out' && (!call.remoteDev || call.remoteDev === msg.dev)) {
      recoverIce(call).catch((e) => console.warn('Ошибка восстановления ICE', e));
    }
    return;
  }
  if (msg.t === 'restart-offer') {
    if (call.dir === 'in' && call.remoteDev === msg.dev) {
      await applyRestartOffer(call, msg);
    }
    return;
  }
  if (msg.t === 'restart-answer') {
    const cur = call;
    if (cur.dir !== 'out' || cur.remoteDev !== msg.dev || msg.gen !== cur.iceGeneration) return;
    if (cur.pc.signalingState !== 'have-local-offer') return;
    try {
      await cur.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      cur.remoteIceGeneration = msg.gen;
      clearInterval(cur.restartResend);
      cur.restartResend = null;
      await flushIce(cur);
      cur.callStep = 'Проверяем новый ICE-маршрут';
    } catch (e) {
      cur.callError = (e?.name || 'Error') + ': ' + (e?.message || e);
    }
    return;
  }
  if (msg.t === 'ring' && call.dir === 'out' && !call.answered) {
    call.ringing = true; call.callStep = 'Приглашение получено собеседником';
    setCallStatus('Звонит…');
    replayIce(call);
  }
  if (msg.t === 'answer' && call.dir === 'out' && !call.answered) {
    const cur = call;
    cur.answered = true;
    cur.remoteDev = msg.dev;
    cur.remoteIceGeneration = 0;
    cur.callStep = 'Ответ получен, согласование соединения';
    clearInterval(cur.resend); stopTone();
    setCallStatus('Соединяю…');
    connectionDeadline(cur);
    try {
      await cur.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      await flushIce(cur);
      replayIce(cur);
    } catch (e) { if (call === cur) { cur.callError = e.name || 'SDPError'; finishCall('failed'); } }
  }
  if (msg.t === 'busy') finishCall('busy');
  if (msg.t === 'end') finishCall(msg.why === 'failed' ? 'failed' : msg.why === 'declined' ? 'declined' : call.connectedAt ? 'ok' : call.dir === 'in' ? 'missed' : 'cancel', { remote: true });
}

// ICE может прийти раньше SDP; применяем его только после remoteDescription.
async function flushIce(cur) {
  if (cur.flushingIce || !cur.pc.remoteDescription || !cur.remoteDev) return;
  cur.flushingIce = true;
  try {
    while (call === cur && cur.pendingIce?.length) {
      const item = cur.pendingIce.shift();
      if (item.dev !== cur.remoteDev) continue;
      const generation = cur.remoteIceGeneration || 0;
      if ((item.gen || 0) > generation) {
        // Кандидат следующего ICE-restart пришёл раньше SDP: ждём новый offer/answer.
        cur.pendingIce.unshift(item);
        break;
      }
      if ((item.gen || 0) < generation) continue;
      const key = JSON.stringify(item.candidate);
      if ((cur.seenIce ||= new Set()).has(key)) continue;
      try {
        await cur.pc.addIceCandidate(item.candidate);
        cur.seenIce.add(key);
      } catch (e) {
        // В мобильных сетях кандидаты могут устаревать; не валим весь звонок.
        cur.lastCandidateError = (e?.name || 'Error') + ': ' + (e?.message || e);
        console.warn('ICE-кандидат отклонён', e);
      }
    }
  } finally { cur.flushingIce = false; }
}
function replayIce(cur) {
  for (const candidate of cur.localIce || []) {
    sendSignal(cur.conv, cur.peer, { t: 'ice', id: cur.id, candidate, gen: cur.iceGeneration || 0 }).catch(() => {});
  }
}
function connectionDeadline(cur) {
  if (cur.connectTimer || cur.connectedAt) return;
  cur.connectStartedAt = Date.now();
  cur.connectClock = setInterval(() => {
    if (call !== cur || cur.connectedAt) return;
    const elapsed = Date.now() - cur.connectStartedAt;
    setCallStatus('Соединяю… ' + fmtDur(elapsed / 1000));
    if (elapsed >= 30000) recoverIce(cur).catch((e) => console.warn('ICE restart не удался', e));
  }, 1000);
  cur.connectTimer = setTimeout(() => {
    if (call === cur && cur.pc.connectionState !== 'connected') recoverIce(cur).catch((e) => console.warn('ICE restart не удался', e));
  }, 30000);
}

/** При проблемах сети только вызывающий инициирует новую ICE-сессию.
 * Это исключает одновременные offer (glare) на двух устройствах.
 * Если TURN не настроен, восстановление не сможет обойти блокировку NAT.
 */
async function recoverIce(cur) {
  if (call !== cur || cur.pc.signalingState === 'closed') return;
  if (cur.iceRecovering) return;
  if (!cur.answered) { finishCall('failed'); return; }
  cur.iceRecovering = true;
  cur.callStep = 'Повторное согласование ICE';
  setCallStatus('Восстанавливаю связь…');
  clearTimeout(cur.connectTimer);
  clearInterval(cur.connectClock);
  clearTimeout(cur.lostTimer);
  cur.connectTimer = null;
  cur.connectClock = null;
  cur.lostTimer = null;
  // Одна попытка восстановления на одну потерю связи.
  cur.recoveryTimeout = setTimeout(() => {
    if (call === cur && cur.pc.connectionState !== 'connected') {
      cur.callError ||= 'ICE: не удалось найти сетевой маршрут даже после повторной попытки';
      finishCall('failed');
    }
  }, 22000);
  if (cur.dir === 'out') {
    await startIceRestart(cur);
  } else {
    const ask = () => {
      if (call !== cur || cur.pc.connectionState === 'connected' || cur.restartOfferReceived) return;
      sendSignal(cur.conv, cur.peer, { t: 'restart-request', id: cur.id }).catch((e) => {
        cur.lastSignalError = (e?.name || 'Error') + ': ' + (e?.message || e);
      });
    };
    ask();
    cur.restartRequestTimer = setInterval(ask, 4000);
  }
}

async function startIceRestart(cur) {
  if (call !== cur || cur.pc.signalingState === 'closed') return;
  if (cur.pc.signalingState !== 'stable') return;
  try {
    cur.iceGeneration = (cur.iceGeneration || 0) + 1;
    cur.localIce = [];
    cur.seenIce = new Set();
    cur.pc.restartIce?.();
    await cur.pc.setLocalDescription(await cur.pc.createOffer({ iceRestart: true }));
    if (call !== cur) return;
    cur.restartOfferSdp = cur.pc.localDescription.sdp;
    const send = () => {
      if (call !== cur || cur.pc.signalingState !== 'have-local-offer') return;
      sendSignal(cur.conv, cur.peer, {
        t: 'restart-offer', id: cur.id, gen: cur.iceGeneration, sdp: cur.restartOfferSdp,
      }).catch((e) => { cur.lastSignalError = (e?.name || 'Error') + ': ' + (e?.message || e); });
    };
    send();
    clearInterval(cur.restartResend);
    cur.restartResend = setInterval(send, 4000);
  } catch (e) {
    if (call === cur) {
      cur.callError = 'ICE restart: ' + (e?.message || String(e));
      finishCall('failed');
    }
  }
}

async function applyRestartOffer(cur, msg) {
  if (call !== cur || !cur.answered || !Number.isSafeInteger(msg.gen) || msg.gen < 1) return;
  if (cur.restartAnswerGen === msg.gen && cur.restartAnswerSdp) {
    sendSignal(cur.conv, cur.peer, {
      t: 'restart-answer', id: cur.id, gen: msg.gen, sdp: cur.restartAnswerSdp,
    }).catch(() => {});
    return;
  }
  if (cur.pc.signalingState !== 'stable') return;
  try {
    cur.restartOfferReceived = true;
    clearInterval(cur.restartRequestTimer);
    cur.restartRequestTimer = null;
    cur.callStep = 'Применяем новый сетевой маршрут';
    await cur.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    if (call !== cur) return;
    cur.remoteIceGeneration = msg.gen;
    cur.iceGeneration = msg.gen;
    cur.localIce = [];
    cur.seenIce = new Set();
    await cur.pc.setLocalDescription(await cur.pc.createAnswer());
    if (call !== cur) return;
    cur.restartAnswerGen = msg.gen;
    cur.restartAnswerSdp = cur.pc.localDescription.sdp;
    await flushIce(cur);
    await sendSignal(cur.conv, cur.peer, {
      t: 'restart-answer', id: cur.id, gen: msg.gen, sdp: cur.restartAnswerSdp,
    });
    cur.callStep = 'Проверяем новый ICE-маршрут';
  } catch (e) {
    cur.callError = 'Повторное согласование: ' + (e?.message || String(e));
    console.warn('ICE restart answer не удался', e);
  }
}

/** Подсказка в SDP: разрешаем видео до VIDEO_BITRATE (некоторые браузеры иначе держат ~600 кбит/с) */
const withBitrate = (sdp) => sdp.replace(/(m=video[^\r\n]*\r?\n(?:(?!m=)[^\r\n]*\r?\n)*?c=[^\r\n]*\r?\n)/, `$1b=AS:${Math.round(VIDEO_BITRATE / 1000)}\r\n`);
const gathered = (pc, ms = 2500) => new Promise((res) => {
  if (pc.iceGatheringState === 'complete') return res();
  const t = setTimeout(res, ms);
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
});

async function getMedia(video) {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) {
    const err = new Error('Браузер не поддерживает микрофон. Откройте мессенджер через HTTPS в Safari или Chrome.');
    err.name = 'NotSupportedError';
    throw err;
  }
  let failure;
  try {
    return await media.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(CALL_BETA ? { channelCount: { ideal: 1 } } : {}) },
      video: video ? camConstraints('user') : false,
    });
  } catch (e) { failure = e; }
  if (video) {
    toast('Камера недоступна — пробую без видео');
    return getMedia(false);
  }
  // Safari иногда отклоняет расширенные ограничения. Проверяем стандартный запрос.
  if (['OverconstrainedError', 'NotReadableError', 'AbortError', 'TypeError'].includes(failure?.name)) {
    try { return await media.getUserMedia({ audio: true, video: false }); }
    catch (e) { failure = e; }
  }
  const reasons = {
    NotAllowedError: 'Микрофон запрещён. Разрешите его в настройках браузера и iPhone.',
    PermissionDeniedError: 'Микрофон запрещён в настройках браузера.',
    NotReadableError: 'Микрофон занят другим приложением или недоступен.',
    NotFoundError: 'Микрофон не найден.',
    SecurityError: 'Для микрофона требуется защищённое HTTPS-соединение.',
  };
  const error = new Error(reasons[failure?.name] || ('Микрофон недоступен: ' + (failure?.message || failure?.name || 'неизвестная ошибка')));
  error.name = failure?.name || 'MediaError';
  error.cause = failure;
  throw error;
}

function makePeer() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const remote = new MediaStream();
  pc.onicecandidateerror = (e) => { if (call?.pc === pc) call.iceError = e.errorCode; };
  pc.onicecandidate = ({ candidate }) => {
    const cur = call;
    if (!candidate || !cur || cur.pc !== pc) return;
    const data = candidate.toJSON();
    (cur.localIce ||= []).push(data);
    sendSignal(cur.conv, cur.peer, { t: 'ice', id: cur.id, candidate: data, gen: cur.iceGeneration || 0 }).catch(() => {});
  };
  pc.ontrack = (e) => {
    for (const tr of (e.streams[0]?.getTracks() || [e.track])) if (!remote.getTracks().includes(tr)) remote.addTrack(tr);
    e.track.onmute = e.track.onunmute = () => { if (call?.pc === pc) updateCallUi(); };
    if (call?.pc === pc) { call.ui.remote.srcObject = remote; call.ui.remote.play?.().catch(() => {}); updateCallUi(); }
  };
  pc.onconnectionstatechange = () => {
    if (!call || call.pc !== pc) return;
    const st = pc.connectionState;
    if (st === 'connected') {
      const cur = call;
      clearTimeout(cur.lostTimer); clearTimeout(cur.connectTimer); clearInterval(cur.connectClock);
      clearTimeout(cur.recoveryTimeout); clearInterval(cur.restartResend); clearInterval(cur.restartRequestTimer);
      cur.lostTimer = null; cur.connectTimer = null; cur.connectClock = null;
      cur.recoveryTimeout = null; cur.restartResend = null; cur.restartRequestTimer = null;
      cur.iceRecovering = false;
      cur.callStep = 'Соединение установлено';
      if (!cur.connectedAt) { cur.connectedAt = Date.now(); stopTone(); cur.clock = setInterval(updateCallUi, 1000); if (cur.extras) cur.extras.start(); else tuneSenders(pc); }
      updateCallUi();
    }
    if (st === 'disconnected') {
      const cur = call;
      clearTimeout(cur.lostTimer);
      setCallStatus('Связь пропала. Восстанавливаю…');
      cur.lostTimer = setTimeout(() => {
        if (call === cur && cur.pc.connectionState !== 'connected') recoverIce(cur).catch((e) => console.warn('ICE recovery', e));
      }, 4000);
    }
    if (st === 'failed') recoverIce(call).catch((e) => console.warn('ICE recovery', e));
  };
  pc.oniceconnectionstatechange = () => {
    if (call?.pc === pc && pc.iceConnectionState === 'failed') {
      recoverIce(call).catch((e) => console.warn('ICE recovery', e));
    }
  };
  return { pc, remote };
}

async function startCall(video) {
  const c = state.chats.get(state.activeId);
  if (!c || c.is_group || isSaved(c)) return;
  if (call) return toast('Вы уже разговариваете');
  if (!window.RTCPeerConnection) return toast('Этот браузер не умеет звонить');
  const peer = otherOf(c);
  if (state.blocked.has(peer)) return toast('Вы заблокировали этого человека');
  if (!hasCurrentKey(c.id)) return toast('Ещё нет ключа шифрования — дождитесь, пока собеседник откроет приложение');
  let local;
  try { local = await getMedia(video); } catch (e) { return toast(e.message); }
  if (call) { local.getTracks().forEach((t) => t.stop()); return; }
  video = local.getVideoTracks().length > 0;
  const id = uuid();
  const { pc, remote } = makePeer();
  call = { id, conv: c.id, peer, video, dir: 'out', pc, local, remote, startedAt: Date.now() };
  call.turnReady = configureCallIce(call);
  local.getTracks().forEach((t) => pc.addTrack(t, local));
  showCallUi();
  setCallStatus('Звоню…');
  startTone('out');
  try {
    await call.turnReady;
    if (!call || call.id !== id) return;
    if (CALL_BETA) prepareVideo(pc, true);
    await pc.setLocalDescription(await pc.createOffer());
    // Trickle ICE: offer отправляем сразу, кандидаты следуют отдельными сигналами.
    if (!call || call.id !== id) return;
    const sdp = withBitrate(pc.localDescription.sdp);
    // запись о звонке в чате: заодно отправит push «новое сообщение», если приложение у собеседника закрыто
    call.logP = insertMessage(c.id, { call: { id, v: video, s: 'ring' } }).then((m) => { addMessage(m); return m; }).catch(() => null);
    const cur = call;
    cur.callStep = 'Отправка приглашения';
    const offer = () => {
      if (call !== cur || cur.answered) return;
      cur.offerAttempts = (cur.offerAttempts || 0) + 1;
      sendSignal(c.id, peer, { t: 'offer', id, video, sdp })
        .then(() => { if (call === cur) { cur.offerDelivered = true; cur.lastSignalError = null; } })
        .catch((e) => {
          if (call !== cur) return;
          cur.offerFailures = (cur.offerFailures || 0) + 1;
          cur.lastSignalError = (e?.name || 'Error') + ': ' + String(e?.message || e);
          cur.callStep = 'Ошибка отправки приглашения (повторяем)';
          console.warn('Не удалось отправить приглашение звонка', e);
        });
    };
    offer();
    call.resend = setInterval(offer, 3000);                 // повторяем, пока собеседник не откроет приложение
    call.giveUp = setTimeout(() => { if (call?.id === id && !call.answered) finishCall('missed'); }, RING_TIMEOUT);
  } catch { if (call?.id === id) finishCall('failed'); }
}

async function incomingOffer(conv, from, msg) {
  if (call) {
    if (call.id !== msg.id) {
      sendSignal(conv, from, { t: 'busy', id: msg.id }).catch(() => {});
    } else if (call.dir === 'in' && call.conv === conv && call.peer === from && call.remoteDev === msg.dev) {
      // Если исходный ответ WebRTC потерялся, повторный offer должен его восстановить.
      // Нельзя создавать новый RTCPeerConnection для того же звонка.
      if (call.answerSdp) {
        const cur = call;
        const now = Date.now();
        if (!cur.lastAnswerRetry || now - cur.lastAnswerRetry > 1500) {
          cur.lastAnswerRetry = now;
          sendSignal(conv, from, { t: 'answer', id: cur.id, sdp: cur.answerSdp })
            .then(() => { if (call === cur) cur.callError = null; })
            .catch((e) => { if (call === cur) cur.callError = (e?.name || 'Error') + ': ' + (e?.message || String(e)); });
        }
      } else if (!call.accepting) {
        sendSignal(conv, from, { t: 'ring', id: msg.id }).catch(() => {});
      }
    }
    return;
  }
  if (state.blocked.has(from)) return;
  const { pc, remote } = makePeer();
  call = { id: msg.id, conv, peer: from, video: !!msg.video, dir: 'in', pc, remote, offer: msg.sdp, remoteDev: msg.dev, startedAt: Date.now() };
  call.turnReady = configureCallIce(call);
  sendSignal(conv, from, { t: 'ring', id: msg.id }).catch(() => {});
  showCallUi();
  setCallStatus(msg.video ? 'Входящий видеозвонок' : 'Входящий звонок');
  startTone('in');
  navigator.vibrate?.([400, 300, 400, 300, 400]);
  flashTitle(msg.video ? '📹 Входящий видеозвонок' : '📞 Входящий звонок');
  if ((document.hidden || !document.hasFocus()) && 'Notification' in window && Notification.permission === 'granted') {
    try { (swReg || await navigator.serviceWorker.ready).showNotification(nameOf(from), { body: msg.video ? 'Входящий видеозвонок' : 'Входящий звонок', tag: 'call', renotify: true, requireInteraction: true, data: { conv } }); } catch {}
  }
  if (call?.id !== msg.id) return;
  call.giveUp = setTimeout(() => { if (call?.id === msg.id && !call.answered) finishCall('missed'); }, RING_TIMEOUT);
}

async function acceptCall(withVideo) {
  if (!call || call.dir !== 'in' || call.answered || call.accepting) return;
  const cur = call;
  cur.accepting = true;
  cur.callStep = 'Принятие звонка';
  // Не отсчитываем 30 секунд соединения, пока пользователь разрешает микрофон.
  clearTimeout(cur.giveUp);
  cur.giveUp = null;
  stopTone();
  stopTitle();
  setCallStatus('Соединяю…');
  try {
    // Запрос микрофона должен запускаться непосредственно после нажатия кнопки:
    // Safari может требовать пользовательский жест для доступа к устройствам.
    cur.callStep = 'Разрешение микрофона (getUserMedia)';
    const local = await getMedia(withVideo && cur.video);
    if (call !== cur) { local.getTracks().forEach((t) => t.stop()); return; }
    cur.local = local;
    cur.callStep = 'Добавление аудио/видео';
    local.getTracks().forEach((t) => cur.pc.addTrack(t, local));
    cur.callStep = 'Настройка STUN/TURN';
    await cur.turnReady;
    if (call !== cur) return;
    cur.callStep = 'Обработка предложения (setRemoteDescription)';
    await cur.pc.setRemoteDescription({ type: 'offer', sdp: cur.offer });
    if (call !== cur) return;
    if (CALL_BETA) prepareVideo(cur.pc);
    await flushIce(cur);

    cur.callStep = 'Формирование ответа (createAnswer)';
    await cur.pc.setLocalDescription(await cur.pc.createAnswer());
    // Trickle ICE: не ждём 2,5 секунды перед передачей ответа.
    if (call !== cur) return;

    cur.callStep = 'Отправка ответа (sendSignal)';
    cur.answerSdp = withBitrate(cur.pc.localDescription.sdp);
    cur.answered = true; // SDP сформирован, хотя доставка ответа пока может потребовать повторения
    tellMyDevices(cur.conv, cur.id).catch(() => {});
    // Ошибка отправки не уничтожает готовое соединение: звонящий повторяет offer
    // раз в три секунды, и обработчик incomingOffer повторит наш answer.
    try {
      await sendSignal(cur.conv, cur.peer, { t: 'answer', id: cur.id, sdp: cur.answerSdp });
      if (call === cur) cur.callError = null;
    } catch (e) {
      if (call === cur) {
        cur.callError = (e?.name || 'Error') + ': ' + String(e?.message || e).slice(0, 260);
        console.warn('Ответ на звонок не доставлен, ожидаем повторного приглашения', e);
      }
    }
    if (call !== cur) return;
    cur.callStep = 'Ожидание соединения';
    connectionDeadline(cur);
    updateCallUi();
  } catch (e) {
    if (call === cur) {
      cur.callError = (e?.name || 'Error') + ': ' + String(e?.message || e).slice(0, 260);
      toast('Не удалось принять звонок: ' + (e?.message || 'неизвестная ошибка'));
      finishCall('failed');
    }
  } finally { cur.accepting = false; }
}

function hangUp(why = 'hangup') {
  if (!call) return;
  sendSignal(call.conv, call.peer, { t: 'end', id: call.id, why }).catch(() => {});
  if (call.dir === 'in' && !call.answered) tellMyDevices(call.conv, call.id).catch(() => {});
  finishCall(why === 'declined' ? 'declined' : call.connectedAt ? 'ok' : call.dir === 'in' ? 'declined' : 'cancel');
}

function callDiagnostics(cur) {
  return [
    'Тест: звонки 3',
    'Направление: ' + (cur.dir === 'in' ? 'входящий' : 'исходящий'),
    'Ответ: ' + (cur.answered ? 'да' : 'нет'),
    'Локальное описание: ' + (cur.pc.localDescription?.type || 'нет'),
    'Описание собеседника: ' + (cur.pc.remoteDescription?.type || 'нет'),
    'Соединение: ' + cur.pc.connectionState,
    'ICE: ' + cur.pc.iceConnectionState,
    'Сбор адресов: ' + cur.pc.iceGatheringState,
    'Адреса: свои ' + (cur.localIce?.length || 0) + ', принятые отдельно ' + (cur.seenIce?.size || 0),
    'Свои типы: ' + describeCandidates(cur.localIce || []),
    'Чужие типы: ' + describeCandidates(cur.remoteIceSeen || []),
    'TURN: ' + (cur.turnAvailable ? 'подключён в браузере' : 'не настроен'),
    'Проверка TURN: ' + (cur.turnError || 'нет ошибок загрузки'),
    'ICE restart: ' + (cur.iceGeneration || 0),
    'Этап: ' + (cur.callStep || 'не определён'),
    'Ошибка: ' + (cur.callError || cur.iceError || cur.lastSignalError || 'нет кода'),
    'Приглашение: попыток ' + (cur.offerAttempts || 0) +
      ', ошибок ' + (cur.offerFailures || 0) + ', принято сервером ' + (cur.offerDelivered ? 'да' : 'нет'),
    'Подтверждение получателя: ' + (cur.ringing ? 'да' : 'нет'),
    'Резервная отправка ответа: ' + (cur.answerSdp ? 'доступна' : 'пока нет'),
  ].join('\n');
}

function finishCall(status, { remote = false, silent = false } = {}) {
  const cur = call;
  if (!cur) return;
  const diagnostics = status === 'failed'
    ? selectedRoute(cur.pc).then((route) => callDiagnostics(cur) + '\nМаршрут: ' + route)
    : null;
  call = null;
  endedCalls.add(cur.id);
  clearInterval(cur.resend); clearInterval(cur.clock); clearTimeout(cur.giveUp); clearTimeout(cur.lostTimer); clearTimeout(cur.connectTimer);
  clearInterval(cur.connectClock); clearTimeout(cur.recoveryTimeout);
  clearInterval(cur.restartResend); clearInterval(cur.restartRequestTimer);
  const dur = cur.connectedAt ? Math.round((Date.now() - cur.connectedAt) / 1000) : 0;
  const text = { ok: 'Звонок завершён · ' + fmtDur(dur), missed: cur.dir === 'out' ? 'Нет ответа' : 'Пропущенный звонок', declined: cur.dir === 'out' ? 'Звонок отклонён' : 'Вы отклонили звонок',
    busy: 'Собеседник занят', failed: 'Не удалось соединиться', cancel: 'Звонок отменён' }[status] || 'Звонок завершён';
  if (cur.ui) {
    cur.ui.root.classList.add('ending');
    setTimeout(() => cur.ui.root.remove(), 900);
    cur.ui.status.textContent = text;
    cur.ui.controls.replaceChildren();
  }
  try { cur.extras?.dispose(); } catch {}
  try { cur.unfit?.(); } catch {}
  try { stopTone(); } catch {}
  try { stopTitle(); } catch {}
  try { if (cur.dir === 'in') (swReg ? Promise.resolve(swReg) : navigator.serviceWorker?.ready)?.then((r) => r?.getNotifications({ tag: 'call' }))
    .then((list) => list?.forEach((n) => n.close())).catch(() => {}); } catch {}
  try { navigator.vibrate?.(0); } catch {}
  cur.local?.getTracks().forEach((t) => { try { t.stop(); } catch {} });
  try { cur.pc.close(); } catch {}
  if (!remote && status === 'failed') sendSignal(cur.conv, cur.peer, { t: 'end', id: cur.id, why: 'failed' }).catch(() => {});
  if (!remote && !cur.answered && cur.dir === 'out' && status === 'missed') sendSignal(cur.conv, cur.peer, { t: 'end', id: cur.id, why: 'timeout' }).catch(() => {});
  if (!silent && status === 'failed') {
    setTimeout(async () => {
      if (call) return;
      const report = await diagnostics;
      if (call) return;
      openModal({ title: 'Звонок не соединился' },
        h('p', { text: 'Эти данные помогут найти причину. Можно отправить скриншот этого окна.' }),
        h('pre', { text: report, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '12px' } }));
    }, 950);
  }
  // итог звонка записывает тот, кто звонил
  if (cur.dir === 'out' && cur.logP) {
    // ждём, пока запишется «звоню…», и только потом меняем её на итог (иначе итог мог потеряться)
    cur.logP.then((m) => m && updatePayload(m, { call: { id: cur.id, v: cur.video, s: status === 'ok' ? 'ok' : status, d: dur } })).catch(() => {});
  }
}

/* ---------- Экран звонка ---------- */
function callButton(cls, ic, label, onclick) {
  return h('button', { class: 'call-ctl ' + cls, type: 'button', title: label, onclick }, h('span', { class: 'call-ctl-ic' }, icon(ic)), h('small', { text: label }));
}
function showCallUi() {
  const cur = call;
  if (CALL_BETA) cur.extras = createCallExtras(cur, {
    active: () => call === cur, update: updateCallUi, notice: toast,
    signal: (msg) => sendSignal(cur.conv, cur.peer, { ...msg, id: cur.id }),
  });
  const remote = h('video', { class: 'call-remote', autoplay: true, playsInline: true });
  remote.setAttribute('playsinline', '');
  const local = h('video', { class: 'call-local', autoplay: true, playsInline: true, muted: true });
  local.setAttribute('playsinline', ''); local.muted = true;
  const status = h('div', { class: 'call-status' });
  const controls = h('div', { class: 'call-controls' });
  const quality = h('div', { class: 'call-quality', text: CALL_BETA ? 'Тест звонков' : '' });
  const peerBox = h('div', { class: 'call-peer' }, userAvatar(cur.peer, 'xl'), h('div', { class: 'call-name', text: nameOf(cur.peer) }), status, quality);
  const root = h('div', { class: 'call-screen' + (cur.video ? ' is-video' : ''), role: 'dialog', 'aria-label': 'Звонок' }, remote, peerBox, local, controls);
  // Вертикальное видео с телефона на широком экране не растягиваем (иначе кадр режется и мылится).
  // Двойное нажатие — переключить «вписать / на весь экран».
  const fit = () => {
    if (root.dataset.fill) return;
    const va = remote.videoWidth / (remote.videoHeight || 1), sa = innerWidth / (innerHeight || 1);
    root.classList.toggle('fit-contain', !!remote.videoWidth && (va / sa < 0.75 || va / sa > 1.6));
  };
  remote.addEventListener('resize', fit);
  remote.addEventListener('loadedmetadata', fit);
  addEventListener('resize', fit);
  cur.unfit = () => removeEventListener('resize', fit);
  remote.addEventListener('dblclick', () => { root.dataset.fill = '1'; root.classList.toggle('fit-contain'); });
  cur.ui = { root, remote, local, status, controls, quality };
  document.body.append(root);
  updateCallUi();
}
function setCallStatus(t) { if (call?.ui && !call.connectedAt) call.ui.status.textContent = t; }
function updateCallUi() {
  const cur = call;
  if (!cur?.ui) return;
  const { ui } = cur;
  const preview = cur.screenPreview || cur.local;
  if (preview && ui.local.srcObject !== preview) { ui.local.srcObject = preview; ui.local.play?.().catch(() => {}); }
  const hasRemoteVideo = cur.remote.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted) && cur.remoteMedia?.video !== false;
  ui.root.classList.toggle('remote-video', hasRemoteVideo && !!cur.connectedAt);
  ui.root.classList.toggle('local-video', !!preview?.getVideoTracks().length);
  ui.root.classList.toggle('local-screen', !!cur.sharingScreen);
  ui.root.classList.toggle('remote-screen', !!cur.remoteMedia?.screen);
  ui.quality.textContent = [CALL_BETA ? 'Тест звонков' : '', cur.callQuality || '', cur.sharingScreen ? 'Вы показываете экран' : cur.remoteMedia?.screen ? 'Собеседник показывает экран' : ''].filter(Boolean).join(' · ');
  if (cur.connectedAt) ui.status.textContent = fmtDur((Date.now() - cur.connectedAt) / 1000);
  const mic = cur.local?.getAudioTracks()[0], cam = cur.local?.getVideoTracks()[0];
  const btns = [];
  if (cur.dir === 'in' && !cur.answered) {
    btns.push(callButton('decline', 'phone', 'Отклонить', () => hangUp('declined')));
    if (cur.video) btns.push(callButton('accept', 'video', 'С видео', () => acceptCall(true)));
    btns.push(callButton('accept', 'phone', cur.video ? 'Без видео' : 'Принять', () => acceptCall(false)));
  } else {
    if (mic) btns.push(callButton(mic.enabled ? '' : 'off', 'mic', mic.enabled ? 'Микрофон' : 'Без звука', () => { mic.enabled = !mic.enabled; updateCallUi(); }));
    if (cam && !cur.sharingScreen) {
      btns.push(callButton(cam.enabled ? '' : 'off', 'video', cam.enabled ? 'Камера' : 'Камера выкл.', () => { cam.enabled = !cam.enabled; cur.extras?.publish(); updateCallUi(); }));
      btns.push(callButton('', 'flip', 'Сменить', () => flipCamera()));
    }
    if (cur.extras && cur.connectedAt) {
      btns.push(callButton(cur.naturalVoice ? 'off' : '', 'settings', cur.naturalVoice ? 'Естественный' : 'Шумоподавление', () => cur.extras.toggleVoice()));
      if (navigator.mediaDevices?.getDisplayMedia) btns.push(callButton(cur.sharingScreen ? 'off' : '', 'screen', cur.sharingScreen ? 'Стоп показ' : 'Экран', () => cur.sharingScreen ? cur.extras.stopScreen() : cur.extras.startScreen()));
    }
    btns.push(callButton('decline', 'phone', 'Завершить', () => hangUp()));
  }
  ui.controls.replaceChildren(...btns);
}
async function flipCamera() {
  const cur = call;
  const old = cur?.local?.getVideoTracks()[0];
  if (!old || cur.sharingScreen) return;
  cur.facing = cur.facing === 'environment' ? 'user' : 'environment';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { ...camConstraints(), facingMode: { exact: cur.facing } } });
    const track = s.getVideoTracks()[0];
    const sender = cur.pc.getSenders().find((x) => x.track?.kind === 'video');
    await sender?.replaceTrack(track);
    tuneSenders(cur.pc);
    cur.local.removeTrack(old); old.stop(); cur.local.addTrack(track);
    cur.ui.local.srcObject = null; updateCallUi();
  } catch { cur.facing = cur.facing === 'environment' ? 'user' : 'environment'; toast('Другой камеры нет'); }
}

/** Мигающий заголовок вкладки, пока звонят (если окно на компьютере свёрнуто или за другими окнами) */
let titleTimer = null;
function flashTitle(text) {
  stopTitle();
  const orig = document.title;
  let on = false;
  titleTimer = setInterval(() => { document.title = (on = !on) ? text : orig; if (!call || call.answered) stopTitle(orig); }, 900);
  flashTitle.orig = orig;
}
function stopTitle(orig = flashTitle.orig) {
  if (!titleTimer) return;
  clearInterval(titleTimer); titleTimer = null;
  if (orig) document.title = orig;
  if (state.me) renderChats();                            // вернуть заголовок со счётчиком непрочитанных
}

/* ---------- Гудки ---------- */
let tone = null;
function startTone(kind) {
  stopTone();
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = () => {
      const t = ctx.currentTime;
      const notes = kind === 'in' ? [[0, 660], [0.18, 880], [0.36, 660], [0.54, 880]] : [[0, 425]];
      for (const [d, f] of notes) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f;
        const len = kind === 'in' ? 0.16 : 1;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(kind === 'in' ? 0.18 : 0.08, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + len);
        o.connect(g).connect(ctx.destination);
        o.start(t + d); o.stop(t + d + len + 0.05);
      }
    };
    beep();
    tone = { ctx, timer: setInterval(beep, kind === 'in' ? 1600 : 4000) };
  } catch {}
}
function stopTone() { if (!tone) return; clearInterval(tone.timer); tone.ctx.close().catch(() => {}); tone = null; }

/* ---------- Запись о звонке в чате ---------- */
function callLabel(cl, mine) {
  const kind = cl.v ? 'Видеозвонок' : 'Звонок';
  if (cl.s === 'ring') return (cl.v ? '📹 ' : '📞 ') + kind;
  if (cl.s === 'ok') return (cl.v ? '📹 ' : '📞 ') + kind + ' · ' + fmtDur(cl.d);
  if (cl.s === 'missed' || cl.s === 'cancel' || cl.s === 'busy') return mine === false ? '📵 Пропущенный звонок' : mine ? (cl.s === 'busy' ? '📵 Собеседник занят' : '📵 Нет ответа') : '📵 Пропущенный звонок';
  if (cl.s === 'declined') return '📵 Звонок отклонён';
  if (cl.s === 'failed') return '📵 Звонок не соединился';
  return '📞 ' + kind;
}
function callBubble(m) {
  const cl = m.p.call, mine = m.sender_id === state.me.id;
  const bad = cl.s && cl.s !== 'ok' && cl.s !== 'ring';
  const title = callLabel(cl, mine).replace(/^\S+\s/, '');
  const sub = cl.s === 'ok' ? (mine ? 'Исходящий' : 'Входящий') + ' · ' + fmtDur(cl.d) : cl.s === 'ring' ? (mine ? 'Исходящий' : 'Входящий') : mine ? 'Исходящий' : 'Входящий';
  return h('div', { class: 'call-box' + (bad ? ' bad' : '') },
    h('span', { class: 'call-box-ic' }, icon(cl.v ? 'video' : 'phone')),
    h('div', { class: 'row-text' }, h('b', { text: title.replace(/ · .*/, '') }), h('small', { text: sub })),
    h('button', { class: 'btn call-again', type: 'button', title: 'Позвонить', onclick: (e) => { e.stopPropagation(); startCall(!!cl.v); } }, icon(cl.v ? 'video' : 'phone')));
}

$('callAudioBtn').onclick = () => startCall(false);
$('callVideoBtn').onclick = () => startCall(true);
addEventListener('beforeunload', () => { if (call) hangUp(); });

/* =====================================================================
   Голосовые сообщения
   ===================================================================== */
const VOICE_MAX = 300;          // 5 минут
const WAVE_BARS = 40;
let rec = null;
// WebM/Opus надёжнее там, где есть (Chrome, Android, Firefox); Safari умеет только MP4 — он и выберется
const pickVoiceMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']
  .find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';

let recStarting = false;        // пока спрашиваем микрофон: второе нажатие не должно начать вторую запись
async function startVoice() {
  if (rec || recStarting) return;
  const chatId = state.activeId;
  if (!chatId) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return inlineError('Этот браузер не умеет записывать голос');
  recStarting = true;
  let stream;
  try {
    if (!(await canSend(chatId))) return;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch { return inlineError('Нет доступа к микрофону. Разрешите его: значок замка у адреса сайта → Микрофон (на iPhone: Настройки → Safari → Микрофон).'); }
  } finally { recStarting = false; }
  if (state.activeId !== chatId) { stream.getTracks().forEach((t) => t.stop()); return; }   // пока разрешали — ушли из чата
  const mime = pickVoiceMime();
  let mr;
  try { mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined); }
  catch { mr = new MediaRecorder(stream); }
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const an = ctx.createAnalyser(); an.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  const chunks = [];
  rec = { mr, stream, ctx, an, chunks, levels: [], start: Date.now(), chat: chatId };
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  // Без нарезки на кусочки: Safari при записи кусочками повторяет и перекрывает фрагменты звука
  mr.start();
  $('composer').classList.add('recording');
  $('recBar').hidden = false;
  $('recWave').replaceChildren();
  rec.timer = setInterval(() => {
    if (!rec) return;
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += (v - 128) ** 2;
    const level = Math.min(1, Math.sqrt(sum / buf.length) / 40);
    rec.levels.push(level);
    const sec = (Date.now() - rec.start) / 1000;
    $('recTime').textContent = fmtDur(sec);
    const bar = h('i'); bar.style.height = Math.max(3, Math.round(level * 26)) + 'px';
    const w = $('recWave'); w.append(bar);
    while (w.children.length > 60) w.firstChild.remove();
    if (sec >= VOICE_MAX) stopVoice(true);
  }, 100);
  sendTyping();
}

async function stopVoice(send) {
  const r = rec;
  if (!r) return;
  rec = null;
  clearInterval(r.timer);
  const stopped = new Promise((res) => { r.mr.onstop = res; });
  try { if (r.mr.state !== 'inactive') r.mr.stop(); else r.mr.onstop(); } catch {}
  await Promise.race([stopped, new Promise((res) => setTimeout(res, 4000))]);
  await new Promise((res) => setTimeout(res, 0));          // последний кусок приходит прямо перед stop
  r.stream.getTracks().forEach((t) => t.stop());
  r.ctx.close().catch(() => {});
  $('composer').classList.remove('recording');
  $('recBar').hidden = true;
  const dur = (Date.now() - r.start) / 1000;
  if (!send) return;
  if (dur < 0.8 || !r.chunks.length) return toast('Слишком коротко — держите запись хотя бы секунду');
  const blob = new Blob(r.chunks, { type: r.mr.mimeType || r.chunks[0].type || 'audio/webm' });
  await sendVoice(blob, dur, waveOf(r.levels), r.chat);
}

/** Сжать уровни громкости до WAVE_BARS столбиков 0…31 */
function waveOf(levels) {
  const peak = Math.max(0.05, ...levels);
  levels = levels.map((x) => x / peak);                    // тихая запись тоже даёт заметную волну
  const out = [];
  for (let i = 0; i < WAVE_BARS; i++) {
    const a = Math.floor((i * levels.length) / WAVE_BARS), b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / WAVE_BARS));
    const part = levels.slice(a, b);
    out.push(Math.max(2, Math.round(31 * Math.min(1, part.length ? Math.max(...part) : 0))));
  }
  return out;
}

async function sendVoice(blob, dur, wave, chatId, extra = null) {
  if (!(await canSend(chatId))) return;
  if (blob.size > 6 * 1024 * 1024) return inlineError('Голосовое слишком длинное');
  $('uploading').hidden = false;
  let uploadedNodes = [], key = null;
  try {
    const kv = currentVersion(chatId);
    const sealed = await E2E.sealBytes(chatKey(chatId, kv), await blob.arrayBuffer(), 'voice|' + chatId);
    const bytes = new Uint8Array(sealed.data);
    const hash = await E2E.sha256hex(bytes);
    key = `${chatId}/${hash}`;
    const v = { iv: sealed.iv, mime: blob.type, dur: Math.round(dur * 10) / 10, w: wave, hash, kv };
    const nodes = await net.put(key, bytes).catch(() => []);
    uploadedNodes = nodes;
    if (nodes.length) v.nodes = nodes;
    else {
      v.path = `${chatId}/${uuid()}.bin`;
      const { error } = await sb.storage.from(BUCKET).upload(v.path, new Blob([bytes], { type: 'application/octet-stream' }), { contentType: 'application/octet-stream' });
      if (error) throw error;
    }
    state.images.set('v:' + (v.path || hash), URL.createObjectURL(blob));
    const msg = await insertMessage(chatId, extra ? { v, f: extra.f } : { v, r: replyRef() });
    if (!extra && state.compose?.mode === 'reply') setCompose(null);
    addMessage(msg);
  } catch (err) {
    if (uploadedNodes.length && key) net.del(uploadedNodes, key);
    inlineError(sendError(err).replace('Не отправилось', 'Голосовое не отправилось'));
  } finally {
    $('uploading').hidden = true;
  }
}

/** Расшифрованное голосовое (кешируется на время сеанса) */
async function voiceBlobUrl(m) {
  const v = m.p.v, ref = 'v:' + (v.path || v.hash);
  if (state.images.has(ref)) return state.images.get(ref);
  const key = chatKey(m.conversation_id, v.kv || m.key_version || 1);
  if (!key) throw new Error('нет ключа');
  let cipher;
  if (v.path) {
    const { data, error } = await sb.storage.from(BUCKET).download(v.path);
    if (error) throw error;
    cipher = await data.arrayBuffer();
  } else {
    cipher = await net.get(v.nodes || [], `${m.conversation_id}/${v.hash}`, v.hash);
    if (!cipher) throw new Error('missing');
  }
  const plain = await E2E.openBytes(key, cipher, v.iv, 'voice|' + m.conversation_id);
  const url = URL.createObjectURL(new Blob([plain], { type: v.mime || 'audio/mp4' }));
  state.images.set(ref, url);
  return url;
}
const voiceBlob = async (m) => (await fetch(await voiceBlobUrl(m))).blob();

let playing = null;             // { audio, stop } — одновременно играет одно голосовое
const voiceAudio = new Map();   // ref -> Audio (чтобы перерисовка не сбивала воспроизведение)
function voiceBubble(m) {
  const v = m.p.v, ref = 'v:' + (v.path || v.hash);
  const bars = h('div', { class: 'voice-wave', title: 'Перемотать' }, ...(v.w || new Array(WAVE_BARS).fill(4)).map((x) => {
    const b = h('i'); b.style.height = Math.max(3, Math.round((x / 31) * 24)) + 'px'; return b;
  }));
  const time = h('span', { class: 'voice-time', text: fmtDur(v.dur) });
  const btn = h('button', { class: 'voice-play', type: 'button', title: 'Слушать' }, icon('play'));
  const speed = h('button', { class: 'voice-speed', type: 'button', title: 'Скорость', text: '1×' });
  const paint = (a) => {
    const ratio = a && a.duration && isFinite(a.duration) ? a.currentTime / a.duration : a ? a.currentTime / (v.dur || 1) : 0;
    const n = Math.round(ratio * bars.children.length);
    [...bars.children].forEach((b, i) => b.classList.toggle('on', i < n));
    time.textContent = a && !a.paused ? fmtDur(a.currentTime) : fmtDur(v.dur);
    btn.replaceChildren(icon(a && !a.paused ? 'pause' : 'play'));
    speed.textContent = (a?.playbackRate || 1) + '×';
  };
  const getAudio = async () => {
    let a = voiceAudio.get(ref);
    if (a) return a;
    btn.classList.add('loading');
    try { a = new Audio(await voiceBlobUrl(m)); } finally { btn.classList.remove('loading'); }
    a.preload = 'auto';
    voiceAudio.set(ref, a);
    a.ontimeupdate = () => a._paint?.(a);
    a.onended = () => { a.currentTime = 0; a._paint?.(a); if (playing?.audio === a) playing = null; };
    a.onpause = () => a._paint?.(a);
    a.onplay = () => a._paint?.(a);
    return a;
  };
  const existing = voiceAudio.get(ref);
  if (existing) { existing._paint = paint; paint(existing); }
  btn.onclick = async (e) => {
    e.stopPropagation();
    try {
      const a = await getAudio();
      a._paint = paint;
      if (!a.paused) return a.pause();
      if (playing && playing.audio !== a) playing.audio.pause();
      playing = { audio: a };
      await a.play();
    } catch (err) {
      toast(/missing/.test(err?.message) ? 'Голосовое сейчас недоступно: узлы сети не отвечают' : 'Не получилось воспроизвести на этом устройстве');
    }
  };
  bars.onclick = async (e) => {
    e.stopPropagation();
    const a = await getAudio().catch(() => null);
    if (!a) return;
    a._paint = paint;
    const r = bars.getBoundingClientRect();
    const total = a.duration && isFinite(a.duration) ? a.duration : v.dur;
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total;
    paint(a);
  };
  speed.onclick = async (e) => {
    e.stopPropagation();
    const a = await getAudio().catch(() => null);
    if (!a) return;
    a._paint = paint;
    a.playbackRate = a.playbackRate === 1 ? 1.5 : a.playbackRate === 1.5 ? 2 : 1;
    paint(a);
  };
  return h('div', { class: 'voice-box' }, btn, h('div', { class: 'voice-mid' }, bars, h('div', { class: 'voice-meta' }, time, speed)));
}

$('micBtn').onclick = () => startVoice();
$('recCancel').onclick = () => stopVoice(false);
$('recSend').onclick = () => stopVoice(true);

/* =====================================================================
   Реальное время
   ===================================================================== */
function subscribe() {
  if (state.channel) sb.removeChannel(state.channel);
  const me = state.me.id;
  let subscribedOnce = false;
  state.channel = sb.channel('inbox-' + me)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => addMessage(p.new, true))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, (p) => onReactionChange(p))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, async (p) => {
      const m = p.new;
      if (!m?.id) return;
      if (!state.history.get(m.conversation_id)?.some((x) => x.id === m.id)) {   // не загружено — нужен только список
        const c = state.chats.get(m.conversation_id);
        if (c?.last_cid && c.last_cid === m.cid) { setLast(c, await decryptMessage({ ...m, p: null })); renderChats(); }
        return;
      }
      if (!chatKey(m.conversation_id, m.key_version)) await loadChatKeys();
      upsertMessage(await decryptMessage({ ...m, p: null }));
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (p) => { if (p.old?.id) removeMessage(p.old.id); })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_members' }, (p) => {
      const r = p.new;
      if (!r) return;
      if (r.conversation_id === state.activeId && r.user_id !== me && state.reads.get(r.user_id) !== r.last_read_at) {
        state.reads.set(r.user_id, r.last_read_at); patchTicks();
      }
      const c = state.chats.get(r.conversation_id);
      if (r.user_id === me && c && c.archived !== r.archived) { c.archived = r.archived; renderChats(); }
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversation_members' }, async (p) => {
      const r = p.new;
      if (!r?.conversation_id) return;
      if (r.user_id === me) { await loadChats(); shareAllChatKeys(); return; }   // меня добавили в чат
      const c = state.chats.get(r.conversation_id);                              // в мою группу добавили человека
      if (!c || (c.member_ids || []).includes(r.user_id)) return;
      c.member_ids = [...(c.member_ids || []), r.user_id];
      await loadPeople([r.user_id]);
      if (c.id === state.activeId) renderHeader();
    })
    // Удаления приходят без фильтра и только с ключом строки (чат + человек): берём лишь свои чаты
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'conversation_members' }, (p) => {
      const r = p.old, c = r && state.chats.get(r.conversation_id);
      if (!c) return;
      if (r.user_id === me) return forgetChat(c.id);           // чат удалили (или вышли с другого устройства)
      c.member_ids = (c.member_ids || []).filter((id) => id !== r.user_id);
      if (c.id === state.activeId) renderHeader();
      if (c.is_group) loadChats();                           // ключ группы сменился — узнаём новую версию
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_keys', filter: `user_id=eq.${me}` },
      () => onChatKeysArrived())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_keys' }, async (p) => {
      const uid = p.new?.user_id;
      if (!uid || uid === me) return;
      await loadPubKeys([uid], true);
      for (const c of state.chats.values()) if ((c.member_ids || []).includes(uid)) shareChatKey(c.id).catch(() => {});
    })
    .subscribe((status) => {
      if (status !== 'SUBSCRIBED' || state.me?.id !== me) return;
      if (subscribedOnce) {
        loadChats().catch((err) => console.warn('Ошибка обновления чатов после восстановления связи', err));
      }
      subscribedOnce = true;
    });
}

async function onChatKeysArrived() {
  const got = await loadChatKeys();
  if (!got.length) return;
  for (const id of got) {
    const c = state.chats.get(id);
    if (c && c.last_sender) c.last_p = (await decryptMessage(lastMessageOf(c))).p;
    // только то, что ещё не открылось: уже расшифрованное заново с узлов не качаем
    await Promise.all((state.history.get(id) || []).filter((m) => !m.p || m.p.bad || m.p.missing).map((m) => { m.p = null; return decryptMessage(m); }));
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
  if (m.conversation_id === state.activeId && i !== -1) replaceBubble(m);
  renderChats();
}

async function addMessage(m, fromServer = false) {
  if (!state.me) return;
  let c = state.chats.get(m.conversation_id);
  if (!c) { await loadChats(); c = state.chats.get(m.conversation_id); if (!c) return; }
  await loadPeople([m.sender_id]);
  if (!chatKey(c.id, m.key_version)) await loadChatKeys();
  await decryptMessage(m);
  if (!state.me) return;
  c = state.chats.get(m.conversation_id) || c;             // список могли перезагрузить, пока расшифровывали
  if ((m.key_version || 1) > (c.key_version || 1)) c.key_version = m.key_version;   // ключ группы сменился

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
    if (hist && isNew) appendBubble(m, m.sender_id === state.me.id);   // повтор своего же с сервера — ничего не меняем
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
    if (missing.length) toast('Не нашли: ' + missing.map((n) => '@' + n).join(', '));
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
    await Promise.all([loadPubKeys([other], true), refreshPerson(other)]);
    const theirs = keys.pub.get(other);
    const codeBox = theirs?.fp
      ? h('div', { class: 'safety' }, ...(await E2E.safetyCode(keys.fp, theirs.fp)).map((g) => h('span', { text: g })))
      : h('p', { text: 'Собеседник ещё не включил шифрование — попросите его открыть новую версию приложения.' });
    const msg = note();
    const blocked = state.blocked.has(other);
    openModal({ title: 'Профиль' },
      h('div', { class: 'profile-head' }, zoomAvatar(userAvatar(other, 'lg'), other),
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
  const members = (c.member_ids || []).map((uid) => h('div', { class: 'member clickable', title: 'Открыть профиль', onclick: () => openUserProfile(uid, id) }, userAvatar(uid, 'xs'),
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
        if (missing.length) toast('Не нашли: ' + missing.map((n) => '@' + n).join(', '));
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
  const drawAvatar = () => avatarSlot.replaceChildren(zoomAvatar(avatar(name.value.trim() || p.username, hue, 'lg', null, frameOf(state.me.id) ? 'frame frame-' + frameOf(state.me.id) : '', photoOf(state.me.id)), state.me.id));
  const swatches = h('div', { class: 'swatches' });
  const drawSwatches = () => swatches.replaceChildren(...HUES.map((hh) => h('button', {
    class: 'swatch' + (hh === hue ? ' on' : ''), vars: { '--h': hh }, title: 'Цвет',
    onclick: () => { hue = hh; drawSwatches(); drawAvatar(); },
  })));
  name.oninput = drawAvatar;
  state.redrawProfileAvatar = drawAvatar;
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
    privacySection(msg),
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
        drawFrames(); renderMe(); renderChats(); state.redrawProfileAvatar?.();
        if (state.activeId) { renderHeader(); renderMessages({ keepScroll: true }); }
        say(msg, f ? 'Рамка «' + label + '» включена' : 'Рамка убрана', 'ok');
      },
    }, avatar(nameOf(me), hueOfUser(me), 'xs', null, f ? 'frame frame-' + f : '', photoOf(me)), h('small', { text: label }))));
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
      await cleanAvatarFolder(null, state.people.get(state.me.id)?.avatar_path);   // фото лежит в открытой корзине — убираем до удаления
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
