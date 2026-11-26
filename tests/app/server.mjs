// Тестовый «Supabase» в памяти + раздача копии сайта. Запуск: node server.mjs <папка сайта> <порт>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.argv[2];
const PORT = +process.argv[3] || 8765;
const JITTER = +(process.env.JITTER ?? 400);   // мс случайной задержки broadcast
const now = () => new Date().toISOString();
const EXM = () => (db.examx?.tpl ? db.examx : db.examx = { tpl: { code: 'python-1', title: 'Основы Python',
  questions: [{ q: 'Какой тип неизменяемый?', opts: ['list', 'dict', 'tuple', 'set'] }, { q: 'type(10 / 2)?', opts: ["<class 'int'>", "<class 'float'>", 'str', 'bool'] }, { q: 'Ключевое слово функции?', opts: ['func', 'function', 'define', 'def'] }],
  key: [2, 1, 3], task: 'Подсчёт чётных чисел', solution: 'n = int(input())' }, exams: [], att: [] });
const exStatus = (a, e) => a.verdict || (a.submitted_at ? 'submitted' : a.started_at && Date.now() > Date.parse(a.due_at) ? 'timeout' : a.started_at ? 'in_progress' : Date.now() > Date.parse(e.deadline) ? 'missed' : 'assigned');
const exScore = (ans) => EXM().tpl.key.filter((k, i) => (ans || [])[i] === k).length;
const GFT = () => (db.giftsx?.kinds ? db.giftsx : db.giftsx = { kinds: [{ kind: 'whisky', name: 'Виски «Дельта»', price: 300, total: 777, active: true }], list: [] });
const uuid = () => crypto.randomUUID();

const slow = { ms: 0, fail: false };
const db = {
  users: [], profiles: [], user_keys: [], key_backups: [], conversations: [], conversation_members: [],
  conversation_keys: [], conversation_key_claims: [], messages: [], reactions: [], blocks: [], nodes: [],
  partner_gifts: [], partner_state: [], push_subscriptions: [], last_seen: [], call_reports: [], badge_grants: [], bans: [], moderators: [], mod_log: [], username_aliases: [], news: [], news_reactions: [], admin_events: [], app_settings: [], turn_providers: [],
};
const files = new Map();        // bucket/path -> { bytes, owner, type }
let msgSeq = 1;
const clients = new Map();      // clientId -> { uid, queue: [], wait: null, subs: [], presence: {} }
const presence = new Map();     // topic -> Map(key -> clientId)

const isMember = (uid, conv) => db.conversation_members.some((m) => m.conversation_id === conv && m.user_id === uid);
const conv = (id) => db.conversations.find((c) => c.id === id);
const prof = (id) => db.profiles.find((p) => p.id === id);
const fail = (message, code = 400) => ({ error: { message, code }, status: code });
const PRM = () => (db.premium?.users ? db.premium : db.premium = { users: [], orders: [] });
const isPrem = (uid) => PRM().users.some((p) => p.user_id === uid && new Date(p.until) > new Date());
const premExtend = (uid, days) => {
  let p = PRM().users.find((x) => x.user_id === uid);
  if (!p) PRM().users.push(p = { user_id: uid, until: now(), nick_color: null });
  p.until = new Date(Math.max(Date.now(), new Date(p.until).getTime()) + days * 864e5).toISOString();
};
/** магазин лимиток: создаётся заново после сброса базы */
const FRT = () => (db.fortune?.prizes ? db.fortune : db.fortune = {
  starts: new Date(Date.now() - 864e5).toISOString(), ends: new Date(Date.now() + 27 * 864e5).toISOString(), off: false,
  prizes: [['l_clover', 2500], ['l_horseshoe', 1200], ['l_dice', 600], ['l_burmalda', 300], ['l_jackpot', 190], ['l_luck', 10]],
  bal: {}, spins: [], orders: [], force: [],
  active() { return !this.off && Date.now() < Date.parse(this.ends); },
  freeLeft(uid) { const day = new Date().toDateString(); return Math.max(0, 3 - this.spins.filter((x) => x.user_id === uid && !x.paid && new Date(x.created_at).toDateString() === day).length); },
});
const LTD = () => (db.limited?.kinds ? db.limited : db.limited = { kinds: [['l_spark', 700, 100], ['l_owl', 900, 90], ['l_coffee', 1200, 80], ['l_pond', 1500, 70], ['l_bug', 1800, 60], ['l_vibe', 2200, 50], ['l_neon', 2700, 45], ['l_comet', 3200, 40], ['l_storm', 3800, 35], ['l_ice', 4500, 30], ['l_flame', 5200, 25], ['l_ghost', 6000, 20], ['l_diamond', 7000, 15], ['l_eclipse', 8000, 12], ['l_legend', 9500, 10], ['l_astro', 11000, 8], ['l_phoenix', 13000, 6], ['l_emperor', 15000, 5], ['l_hole', 17500, 3], ['l_absolute', 20000, 1], ['l_cinema', 10000, 10], ['l_clover', 500, 300], ['l_horseshoe', 1500, 150], ['l_dice', 4000, 60], ['l_burmalda', 2500, 100], ['l_jackpot', 15000, 20], ['l_luck', 500000, 3]].map(([kind, price, total]) => ({ kind, price, total })), items: [], orders: [] });

/* ---------- события ---------- */
function push(cid, ev) {
  const c = clients.get(cid);
  if (!c) return;
  c.queue.push(ev);
  if (c.wait) { const w = c.wait; c.wait = null; w(); }
}
/** postgres_changes: кому отправить — решает visible(uid) */
let evSeq = 0;
function logEvent(kind, text, go = null) {
  const row = { id: ++evSeq, kind, text, go, created_at: now() };
  db.admin_events.push(row);
  change('admin_events', 'INSERT', row, null, (u) => prof(u)?.role === 'creator');
}
function change(table, eventType, row, old, visible) {
  for (const [cid, c] of clients) {
    if (!c.uid) continue;
    for (const s of c.subs) {
      if (s.kind !== 'pg' || s.table !== table || (s.event !== '*' && s.event !== eventType)) continue;
      if (s.filter) { const [col, val] = s.filter.split('=eq.'); const r = row || old; if (String(r?.[col]) !== val) continue; }
      if (!visible(c.uid)) continue;
      push(cid, { topic: s.topic, type: 'pg', id: s.id, payload: { eventType, new: row || {}, old: old || {} } });
    }
  }
}
const membersOf = (convId) => (uid) => isMember(uid, convId);

/* ---------- таблицы ---------- */
function applyFilters(rows, filters) {
  return rows.filter((r) => filters.every(([op, col, val]) => {
    const v = r[col];
    if (op === 'eq') return String(v) === String(val);
    if (op === 'neq') return String(v) !== String(val);
    if (op === 'in') return val.map(String).includes(String(v));
    if (op === 'lt') return v < val;
    if (op === 'gt') return v > val;
    if (op === 'is') return v === val;
    return true;
  }));
}
function readable(uid, table, r) {
  switch (table) {
    case 'messages': case 'reactions': case 'conversation_keys': case 'conversation_members': return isMember(uid, r.conversation_id);
    case 'conversations': return isMember(uid, r.id);
    case 'key_backups': case 'push_subscriptions': return r.user_id === uid;
    case 'blocks': return r.blocker === uid;
    case 'partner_gifts': return r.partner_id === uid || r.friend_id === uid;
    case 'nodes': return r.status === 'active' || r.owner === uid;
    case 'turn_providers': return r.owner === uid;
    case 'admin_events': return prof(uid)?.role === 'creator';
    default: return true;
  }
}
function query(uid, q) {
  const t = db[q.table];
  if (!t) return fail(`relation "${q.table}" does not exist`);
  let res;
  if (q.op === 'select') {
    res = applyFilters(t.filter((r) => readable(uid, q.table, r)), q.filters);
    if (q.order) res.sort((a, b) => (a[q.order.col] < b[q.order.col] ? -1 : a[q.order.col] > b[q.order.col] ? 1 : 0) * (q.order.asc ? 1 : -1));
    if (q.limit) res = res.slice(0, q.limit);
    res = res.map((r) => ({ ...r }));
    if (q.table === 'turn_providers') res.forEach((r) => delete r.credential);   // пароль не отдаётся, как в базе
  } else if (q.op === 'insert' || q.op === 'upsert') {
    res = [];
    for (const raw of [].concat(q.values)) {
      const r = { ...raw };
      const err = beforeWrite(uid, q.table, r, null);
      if (err) return err;
      let existing = null;
      if (q.op === 'upsert') {
        const keys = (q.onConflict || pk(q.table)).split(',');
        existing = t.find((x) => keys.every((k) => String(x[k]) === String(r[k])));
      }
      if (existing) { const old = { ...existing }; Object.assign(existing, r); afterWrite(q.table, 'UPDATE', existing, old); res.push({ ...existing }); }
      else {
        if (q.table === 'blocks' && t.some((x) => x.blocker === r.blocker && x.blocked === r.blocked)) return fail('duplicate key value');
        t.push(r); afterWrite(q.table, 'INSERT', r, null); res.push({ ...r });
      }
    }
  } else if (q.op === 'update') {
    res = [];
    for (const r of applyFilters(t.filter((x) => writable(uid, q.table, x)), q.filters)) {
      const old = { ...r };
      const next = { ...r, ...q.values };
      const err = beforeWrite(uid, q.table, next, old);
      if (err) return err;
      Object.assign(r, next);
      afterWrite(q.table, 'UPDATE', r, old);
      res.push({ ...r });
    }
  } else if (q.op === 'delete') {
    const gone = applyFilters(t.filter((x) => writable(uid, q.table, x)), q.filters);
    for (const r of gone) { t.splice(t.indexOf(r), 1); afterWrite(q.table, 'DELETE', null, r); }
    res = gone;
  }
  if (q.single && res.length !== 1) return q.maybe && !res.length ? { data: null } : fail('JSON object requested, multiple (or no) rows returned');
  return { data: q.single ? res[0] : res };
}
const pk = (t) => ({ conversation_keys: 'conversation_id,user_id,version', reactions: 'message_id,user_id', conversation_members: 'conversation_id,user_id' }[t] || (t === 'profiles' ? 'id' : 'user_id'));
function writable(uid, table, r) {
  switch (table) {
    case 'messages': return r.sender_id === uid;
    case 'profiles': return r.id === uid;
    case 'conversation_members': return r.user_id === uid;
    case 'conversation_keys': return r.user_id === uid || isMember(uid, r.conversation_id);
    case 'reactions': case 'user_keys': case 'key_backups': case 'push_subscriptions': return r.user_id === uid;
    case 'blocks': return r.blocker === uid;
    case 'news': return prof(uid)?.role === 'creator';
    case 'news_reactions': return r.user_id === uid;
    default: return false;
  }
}
let newsSeq = 0;
function beforeWrite(uid, table, r, old) {
  if (table === 'news') {
    if (prof(uid)?.role !== 'creator') return fail('new row violates row-level security policy for table "news"');
    if (!old) { r.id = ++newsSeq; r.author = uid; r.created_at = now(); r.edited_at = null; }
    else if (r.body !== old.body) r.edited_at = now();
    return null;
  }
  if (table === 'news_reactions') {
    if (!old) {
      r.user_id = uid;
      if (db.news_reactions.filter((x) => x.news_id === r.news_id && x.user_id === uid).length >= 3) return fail('new row violates row-level security policy for table "news_reactions"');
      if (db.news_reactions.some((x) => x.news_id === r.news_id && x.user_id === uid && x.emoji === r.emoji)) return fail('duplicate key value');
    }
    return null;
  }
  if (table === 'messages') {
    const c = conv(r.conversation_id);
    if (!old && db.bans.some((b) => b.user_id === uid)) return fail('new row violates row-level security policy "messages: not banned" for table "messages"');
    if (!old) {
      if (r.sender_id !== uid || !isMember(uid, r.conversation_id) || !c || (r.key_version || 1) !== c.key_version) return fail('new row violates row-level security policy for table "messages"');
      if (c.is_official && !prof(uid)?.role) return fail('new row violates row-level security policy for table "messages"');
      if (!c.is_group) {
        const other = db.conversation_members.find((m) => m.conversation_id === c.id && m.user_id !== uid)?.user_id;
        if (other && db.blocks.some((b) => (b.blocker === uid && b.blocked === other) || (b.blocker === other && b.blocked === uid))) return fail('new row violates row-level security policy for table "messages"');
      }
      r.id = msgSeq++; r.created_at = now(); r.edited_at = null; r.key_version = r.key_version || 1;
    } else {
      if (r.key_version !== c.key_version) return fail('stale key version');
      r.edited_at = now();
    }
  }
  if (table === 'profiles' && old && r.username !== old.username) return fail('username cannot be changed');
  if (table === 'conversation_keys' && !old) r.created_at = now();
  if (table === 'reactions' && !old) { if (!isMember(uid, r.conversation_id)) return fail('new row violates row-level security policy'); r.created_at = now(); }
  if (table === 'blocks' && !old) r.created_at = now();
  return null;
}
function afterWrite(table, ev, row, old) {
  const r = row || old;
  if (table === 'news' || table === 'news_reactions') return change(table, ev, row, old, () => true);
  if (table === 'messages') {
    if (ev === 'INSERT') {
      const c = conv(row.conversation_id); c.last_message_at = row.created_at;
      const me = db.conversation_members.find((m) => m.conversation_id === c.id && m.user_id === row.sender_id);
      if (me) { const o = { ...me }; me.last_read_at = row.created_at; afterWrite('conversation_members', 'UPDATE', me, o); }
      change('messages', 'INSERT', row, null, membersOf(row.conversation_id));
    } else if (ev === 'UPDATE') change('messages', 'UPDATE', row, null, membersOf(row.conversation_id));
    else { db.reactions = db.reactions.filter((x) => x.message_id !== old.id); change('messages', 'DELETE', null, { id: old.id }, () => true); }
  } else if (table === 'reactions') {
    if (ev === 'DELETE') change('reactions', 'DELETE', null, { message_id: old.message_id, user_id: old.user_id }, () => true);
    else change('reactions', ev, row, null, membersOf(row.conversation_id));
  } else if (table === 'conversation_members') {
    if (ev === 'DELETE') {
      change('conversation_members', 'DELETE', null, { conversation_id: old.conversation_id, user_id: old.user_id }, () => true);
      const c = conv(old.conversation_id); if (c?.is_group) c.key_version++;
    } else change('conversation_members', ev, row, null, membersOf(r.conversation_id));
  } else if (table === 'conversation_keys') change('conversation_keys', ev, row, old, (uid) => uid === r.user_id);
  else if (table === 'user_keys') change('user_keys', ev, row, old, () => true);
}

/* ---------- функции (rpc) ---------- */
function addMember(convId, uid) {
  if (db.conversation_members.some((m) => m.conversation_id === convId && m.user_id === uid)) return false;
  const row = { conversation_id: convId, user_id: uid, last_read_at: null, archived: false, joined_at: now() };
  db.conversation_members.push(row);
  afterWrite('conversation_members', 'INSERT', row, null);
  return true;
}
const blockedBetween = (a, b) => db.blocks.some((x) => (x.blocker === a && x.blocked === b) || (x.blocker === b && x.blocked === a));
const newConv = (o) => { const c = { id: uuid(), is_group: false, title: null, is_official: false, key_version: 1, key_checks: {}, last_message_at: now(), created_at: now(), ...o }; db.conversations.push(c); return c; };
const activeMod = (uid) => (db.moderators || []).find((m) => m.user_id === uid && (!m.until || new Date(m.until) > new Date()));
const modLevel = (uid) => db.bans.some((b) => b.user_id === uid) ? 0 : prof(uid)?.role === 'creator' ? 3 : activeMod(uid)?.level === 'senior' ? 2 : activeMod(uid) ? 1 : 0;
const RPC = {
  username_available: (uid, { name }) => !db.profiles.some((p) => p.username === name.toLowerCase()) && !db.username_aliases.some((a) => a.alias === name.toLowerCase()),
  set_role: (uid, { p_username, p_role }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators can change roles');
    const p = db.profiles.find((x) => x.username === String(p_username).toLowerCase());
    if (!p || p.role === 'creator') return fail('user not found or is a creator');
    p.role = p_role; return null;
  },
  admin_users: (uid, { p_q }) => {
    if (modLevel(uid) < 1) return fail('only creators');
    return db.profiles.filter((p) => !p_q || p.username.includes(p_q)).map((p) => {
      const b = db.bans.find((x) => x.user_id === p.id), m = activeMod(p.id);
      return { id: p.id, username: p.username, display_name: p.display_name || null, role: p.role || null, created_at: p.created_at || now(), seen_at: now(),
        banned: !!b, ban_until: b?.until || null, ban_reason: b?.reason || null, badges: db.badge_grants.filter((g) => g.user_id === p.id).map((g) => g.kind),
        nodes: 0, turns: db.turn_providers.filter((t) => t.owner === p.id).length, msgs: db.messages.filter((m2) => m2.sender_id === p.id).length, tier: null,
        mod: m?.level || null, mod_until: m?.until || null, banned_by: b ? prof(b.by_user)?.username || null : null };
    });
  },
  admin_stats: (uid) => modLevel(uid) < 2 ? fail('only creators') : ({ users: db.profiles.length, new_week: db.profiles.length, active_day: 1, active_week: 2,
    messages: db.messages.length, messages_day: db.messages.length, chats: db.conversations.length, groups: db.conversations.filter((c) => c.is_group).length,
    db_bytes: 12345678, storage_bytes: 2345678, nodes_active: 0, nodes_total: 0, turn_active: 0, turn_total: db.turn_providers.length, calls_day: 0, calls_ok_day: 0, banned: db.bans.length }),
  set_moderator: (uid, { p_username, p_level, p_minutes }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators manage moderators');
    const p = db.profiles.find((x) => x.username === String(p_username).toLowerCase());
    if (!p) return fail('user not found');
    if (p.role === 'creator') return fail('creator is already above moderators');
    db.moderators = db.moderators.filter((m) => m.user_id !== p.id);
    if (p_level) {
      if (!['moderator', 'senior'].includes(p_level)) return fail('bad moderator level');
      db.moderators.push({ user_id: p.id, level: p_level, until: p_minutes ? new Date(Date.now() + p_minutes * 60e3).toISOString() : null, by_user: uid });
    }
    db.mod_log.push({ id: db.mod_log.length + 1, actor: uid, action: p_level ? 'mod_on' : 'mod_off', target: p.id, details: p_level || null, created_at: now() });
    return null;
  },
  mod_log_list: (uid) => prof(uid)?.role !== 'creator' ? fail('only creators')
    : db.mod_log.slice().reverse().map((l) => ({ ...l, actor: prof(l.actor)?.username, target: prof(l.target)?.username })),
  ban_user: (uid, { p_username, p_days, p_reason }) => {
    const lvl = modLevel(uid);
    if (lvl < 1) return fail('only creators can ban');
    const p = db.profiles.find((x) => x.username === String(p_username).toLowerCase());
    if (!p) return fail('user not found');
    if (p.role === 'creator') return fail('cannot ban a creator');
    if (p.id === uid || modLevel(p.id) >= lvl) return fail('cannot ban your level or higher');
    if (lvl === 1 && !(p_days >= 1 && p_days <= 7)) return fail('moderators ban for 1 to 7 days');
    const old = db.bans.find((b) => b.user_id === p.id);
    if (old && old.by_user !== uid && modLevel(old.by_user) > lvl) return fail('ban was set by someone higher');
    db.bans = db.bans.filter((b) => b.user_id !== p.id).concat({ user_id: p.id, reason: p_reason, until: p_days ? new Date(Date.now() + p_days * 864e5).toISOString() : null, by_user: uid });
    db.mod_log.push({ id: db.mod_log.length + 1, actor: uid, action: 'ban', target: p.id, details: (p_days ? p_days + ' дн.' : 'навсегда') + (p_reason ? ': ' + p_reason : ''), created_at: now() });
    return null;
  },
  unban_user: (uid, { p_username }) => {
    const lvl = modLevel(uid);
    if (lvl < 1) return fail('only creators can ban');
    const p = db.profiles.find((x) => x.username === String(p_username).toLowerCase());
    const old = db.bans.find((b) => b.user_id === p?.id);
    if (!old) return null;
    if (old.by_user !== uid && modLevel(old.by_user) > lvl) return fail('ban was set by someone higher');
    db.bans = db.bans.filter((b) => b.user_id !== p.id);
    db.mod_log.push({ id: db.mod_log.length + 1, actor: uid, action: 'unban', target: p.id, details: null, created_at: now() });
    return null;
  },
  change_username: (uid, { p_new }) => {
    const u = String(p_new).toLowerCase(), me = prof(uid);
    if (!/^[a-z0-9_]{3,24}$/.test(u)) return fail('bad username');
    if (me.username_changed_at && Date.now() - Date.parse(me.username_changed_at) < 30 * 864e5) return fail('username change too soon: 10.12.2026');
    if (db.profiles.some((p) => p.username === u) || db.username_aliases.some((a) => a.alias === u && a.user_id !== uid)) return fail('username taken');
    db.username_aliases = db.username_aliases.filter((a) => a.alias !== u).concat({ alias: me.username, user_id: uid, until: new Date(Date.now() + 30 * 864e5).toISOString() });
    me.username = u; me.username_changed_at = now();
    return u;
  },
  my_chats: (uid) => db.conversation_members.filter((m) => m.user_id === uid).map((m) => {
    const c = conv(m.conversation_id);
    const lm = db.messages.filter((x) => x.conversation_id === c.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    return { id: c.id, is_group: c.is_group, title: c.title, is_official: c.is_official, archived: m.archived, key_version: c.key_version, key_checks: c.key_checks,
      last_message_at: c.last_message_at, last_read_at: m.last_read_at, last_ct: lm?.ct ?? null, last_iv: lm?.iv ?? null, last_sender: lm?.sender_id ?? null,
      last_hash: lm?.ct_hash ?? null, last_nodes: lm?.nodes ?? null, last_cid: lm?.cid ?? null, last_sig: lm?.sig ?? null, last_key_version: lm?.key_version ?? null,
      member_ids: db.conversation_members.filter((x) => x.conversation_id === c.id).map((x) => x.user_id), pin_order: m.pin_order ?? null };
  }),
  set_pins: (uid, { p_ids }) => {
    if ((p_ids || []).length > 10) return fail('too many pins');
    for (const m of db.conversation_members.filter((x) => x.user_id === uid)) {
      const i = (p_ids || []).indexOf(m.conversation_id), next = i === -1 ? null : i + 1;
      if ((m.pin_order ?? null) !== next) { const o = { ...m }; m.pin_order = next; afterWrite('conversation_members', 'UPDATE', m, o); }
    }
    return null;
  },
  get_or_create_dm: (uid, { other }) => {
    if (other === uid) return fail('cannot chat with yourself');
    if (blockedBetween(uid, other)) return fail('blocked');
    const k = [uid, other].sort().join(':');
    const c = db.conversations.find((x) => x.dm_key === k) || newConv({ dm_key: k, created_by: uid });
    addMember(c.id, uid); addMember(c.id, other);
    return c.id;
  },
  get_or_create_saved: (uid) => {
    const k = 'saved:' + uid;
    const c = db.conversations.find((x) => x.dm_key === k) || newConv({ dm_key: k, created_by: uid });
    addMember(c.id, uid);
    return c.id;
  },
  create_group: (uid, { group_title, usernames }) => {
    const c = newConv({ is_group: true, title: group_title, created_by: uid });
    addMember(c.id, uid);
    for (const u of usernames) { const p = db.profiles.find((x) => x.username === u); if (p && !blockedBetween(uid, p.id)) addMember(c.id, p.id); }
    return c.id;
  },
  add_group_members: (uid, { conv: id, usernames }) => {
    if (!isMember(uid, id)) return fail('not a member');
    let n = 0;
    for (const u of usernames) { const p = db.profiles.find((x) => x.username === u); if (p && !blockedBetween(uid, p.id) && addMember(id, p.id)) n++; }
    return n;
  },
  rename_group: (uid, { conv: id, new_title }) => { if (!isMember(uid, id)) return fail('not a member'); conv(id).title = new_title.trim().slice(0, 60); return null; },
  delete_dm: (uid, { conv: id }) => {
    if (!isMember(uid, id)) return fail('not a member');
    for (const m of db.messages.filter((x) => x.conversation_id === id)) { db.messages.splice(db.messages.indexOf(m), 1); afterWrite('messages', 'DELETE', null, m); }
    for (const m of db.conversation_members.filter((x) => x.conversation_id === id)) { db.conversation_members.splice(db.conversation_members.indexOf(m), 1); afterWrite('conversation_members', 'DELETE', null, m); }
    db.conversations = db.conversations.filter((c) => c.id !== id);
    return null;
  },
  claim_conversation_key: (uid, { conv: id, p_check }) => {
    if (!isMember(uid, id)) return fail('not a member');
    const c = conv(id), v = c.key_version;
    if (db.conversation_keys.some((k) => k.conversation_id === id && k.version === v)) return false;
    const cl = db.conversation_key_claims.find((k) => k.conversation_id === id && k.version === v);
    if (cl && Date.now() - cl.at < 30000) return false;      // занято (в т.ч. самим собой с другого устройства) — ждём ключ
    if (cl) { cl.claimed_by = uid; cl.at = Date.now(); } else db.conversation_key_claims.push({ conversation_id: id, version: v, claimed_by: uid, at: Date.now() });
    c.key_checks = { ...c.key_checks, [v]: p_check };
    return true;
  },
  perks_list: () => db.partner_state.filter((s) => s.active).map((s) => ({ user_id: s.user_id, kind: 'partner', tier: s.tier || 'bronze' })),
  partner_top: () => [], node_stats: () => [],
  register_turn: (uid, { p_urls, p_username, p_credential }) => {
    if (!p_urls?.length || p_urls.some((u) => !/^turns?:[A-Za-z0-9.-]{3,253}(:[0-9]{2,5})?(\?transport=(udp|tcp))?$/.test(u))) return fail('bad turn urls');
    if (db.turn_providers.filter((t) => t.owner === uid).length >= 2) return fail('too many turn servers');
    const t = { id: uuid(), owner: uid, urls: p_urls, username: p_username, credential: p_credential, status: 'pending', last_ok: null, last_error: null, created_at: now() };
    db.turn_providers.push(t); return t.id;
  },
  delete_turn: (uid, { p_id }) => { db.turn_providers = db.turn_providers.filter((t) => !(t.id === p_id && t.owner === uid)); return null; },
  set_app_setting: (uid, { p_key, p_value }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators change settings');
    if (p_key === 'donate_url' && p_value && !/^https:\/\/\S{8,}$/.test(p_value)) return fail('bad donate url');
    db.app_settings = db.app_settings.filter((x) => x.key !== p_key);
    if (p_value) db.app_settings.push({ key: p_key, value: p_value });
    return null;
  },
  set_badge: (uid, { p_username, p_kind, p_on }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators can grant badges');
    if (!['donor', 'tester', 'bronze', 'silver', 'gold', 'plus', 'relay'].includes(p_kind)) return fail('bad badge');
    const p = db.profiles.find((x) => x.username === String(p_username).replace(/^@/, '').toLowerCase());
    if (!p) return fail('user not found');
    db.badge_grants = db.badge_grants.filter((d) => !(d.user_id === p.id && d.kind === p_kind));
    if (p_on) db.badge_grants.push({ user_id: p.id, kind: p_kind, since: now() });
    return null;
  },
  // ---- Приложение iPhone (update-24) ----
  app_register: (uid) => { const sec = 'sec-' + uid.slice(0, 8) + '-' + Math.random().toString(36).slice(2); (db.app_devices ||= []).push({ user_id: uid, secret: sec }); return sec; },
  app_unregister: (uid, { p_secret }) => { db.app_devices = (db.app_devices || []).filter((d) => d.secret !== p_secret); return null; },
  // ---- Тесты команды (update-30) ----
  exam_templates_list: (uid) => prof(uid)?.role !== 'creator' ? fail('only creators') : [{ code: 'python-1', title: EXM().tpl.title, questions: EXM().tpl.questions.length },
    ...(EXM().own || []).map((t) => ({ code: t.code, title: t.title, questions: t.questions.length }))],
  exam_template_save: (uid, { p_code, p_title, p_questions, p_key, p_task, p_solution }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators');
    if (!String(p_title || '').trim()) return fail('bad exam title');
    if (!Array.isArray(p_questions) || !p_questions.length || p_key.length !== p_questions.length) return fail('bad exam questions');
    const bad = p_key.findIndex((k, i) => !Number.isInteger(k) || k < 0 || k >= p_questions[i].opts.length); if (bad >= 0) return fail('exam answer missing ' + (bad + 1));
    const X = EXM(); X.own ||= [];
    const code = p_code || 't' + Date.now(); X.own = X.own.filter((t) => t.code !== code);
    X.own.push({ code, title: p_title.trim(), questions: p_questions, key: p_key, task: p_task || null, solution: p_solution || null }); return code;
  },
  exam_template_get: (uid, { p_code }) => { const t = (EXM().own || []).find((x) => x.code === p_code); return t ? [{ code: t.code, title: t.title, questions: t.questions, answer_key: t.key, task: t.task, solution: t.solution, used: false }] : []; },
  exam_template_delete: (uid, { p_code }) => { EXM().own = (EXM().own || []).filter((x) => x.code !== p_code); return null; },
  exam_launch: (uid, { p_template, p_hours, p_minutes }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators');
    if (!(p_hours >= 1 && p_hours <= 720)) return fail('bad exam deadline');
    if (!(p_minutes >= 5 && p_minutes <= 600)) return fail('bad exam time');
    const X = EXM(), e = { id: X.exams.length + 1, title: X.tpl.title, deadline: new Date(Date.now() + p_hours * 36e5).toISOString(), minutes: p_minutes, created_at: now() };
    X.exams.push(e);
    for (const p of db.profiles) if (p.role !== 'creator' && (p.role === 'tester' || activeMod(p.id)?.level === 'senior'))
      X.att.push({ id: X.att.length + 1, exam_id: e.id, user_id: p.id, started_at: null, due_at: null, submitted_at: null, answers: [], code: null, verdict: null, note: null });
    logEvent('exam', 'Запущен тест', 'exams'); return e.id;
  },
  exam_mine: (uid) => EXM().att.filter((a) => a.user_id === uid).map((a) => { const e = EXM().exams.find((x) => x.id === a.exam_id);
    return { attempt_id: a.id, title: e.title, deadline: e.deadline, minutes: e.minutes, started_at: a.started_at, due_at: a.due_at, status: exStatus(a, e), questions: EXM().tpl.questions.length, has_task: true }; }).reverse(),
  exam_start: (uid, { p_attempt }) => {
    const a = EXM().att.find((x) => x.id === p_attempt && x.user_id === uid); if (!a) return fail('exam not found');
    const e = EXM().exams.find((x) => x.id === a.exam_id);
    if (!a.started_at) { if (Date.now() > Date.parse(e.deadline)) return fail('exam missed'); a.started_at = now(); a.due_at = new Date(Date.now() + e.minutes * 60e3).toISOString(); }
    return [{ title: e.title, questions: EXM().tpl.questions, task: EXM().tpl.task, due_at: a.due_at, answers: a.answers, code: a.code, status: exStatus(a, e) }];
  },
  exam_save: (uid, { p_attempt, p_answers, p_code, p_final }) => {
    const a = EXM().att.find((x) => x.id === p_attempt && x.user_id === uid); if (!a) return fail('exam not found');
    const e = EXM().exams.find((x) => x.id === a.exam_id);
    if (!a.started_at) return fail('exam not started');
    if (a.submitted_at || a.verdict) return fail('exam already submitted');
    if (Date.now() > Date.parse(a.due_at) + 30e3) return fail('exam time is over');
    a.answers = p_answers || []; a.code = p_code ?? null; if (p_final) a.submitted_at = now();
    return exStatus(a, e);
  },
  exams_list: (uid) => prof(uid)?.role !== 'creator' ? fail('only creators') : EXM().exams.map((e) => { const as = EXM().att.filter((a) => a.exam_id === e.id);
    return { ...e, total: as.length, done: as.filter((a) => a.verdict).length, waiting: as.filter((a) => !a.verdict && (a.submitted_at || (a.due_at && Date.now() > Date.parse(a.due_at)))).length }; }).reverse(),
  exam_results: (uid, { p_exam }) => prof(uid)?.role !== 'creator' ? fail('only creators') : EXM().att.filter((a) => a.exam_id === p_exam).map((a) => { const e = EXM().exams.find((x) => x.id === a.exam_id);
    return { attempt_id: a.id, user_id: a.user_id, username: prof(a.user_id)?.username, mod_level: activeMod(a.user_id)?.level || null, role: prof(a.user_id)?.role || null, status: exStatus(a, e), score: a.started_at ? exScore(a.answers) : null, questions: EXM().tpl.key.length, started_at: a.started_at, submitted_at: a.submitted_at, verdict: a.verdict }; }),
  exam_attempt_detail: (uid, { p_attempt }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators');
    const a = EXM().att.find((x) => x.id === p_attempt), e = EXM().exams.find((x) => x.id === a.exam_id), T = EXM().tpl;
    return [{ username: prof(a.user_id)?.username, title: e.title, status: exStatus(a, e), questions: T.questions, answer_key: T.key, answers: a.answers, score: exScore(a.answers), task: T.task, code: a.code, solution: T.solution, started_at: a.started_at, submitted_at: a.submitted_at, verdict: a.verdict, note: a.note }];
  },
  exam_verdict: (uid, { p_attempt, p_pass, p_strip, p_note }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators');
    const a = EXM().att.find((x) => x.id === p_attempt); if (!a) return fail('exam not found');
    a.verdict = p_pass ? 'pass' : 'fail'; a.note = p_note || null;
    if (!p_pass && p_strip) { const pr = prof(a.user_id); if (pr.role === 'tester') pr.role = null; db.moderators = (db.moderators || []).filter((m) => m.user_id !== a.user_id); }
    return null;
  },
  // ---- Подарки (update-29) ----
  gifts_catalog: () => GFT().kinds.map((k) => ({ ...k, sold: GFT().list.filter((g) => g.kind === k.kind && ['sent', 'pending'].includes(g.status)).length })),
  gift_send: (uid, { p_kind, p_to, p_message, p_anon, p_proof }) => {
    const G = GFT(), k = G.kinds.find((x) => x.kind === p_kind && x.active), creator = prof(uid)?.role === 'creator', proof = String(p_proof || '').trim();
    if (!k) return fail('no such gift');
    const r = db.profiles.find((x) => x.username === String(p_to || '').trim().replace(/^@/, '').toLowerCase());
    if (!r) return fail('user not found');
    const msg = String(p_message || '').trim() || null;
    if (msg && msg.length > 200) return fail('gift message too long');
    if (!creator && (proof.length < 5 || proof.length > 300)) return fail('bad proof');
    if (!creator && G.list.filter((g) => g.sender === uid && g.status === 'pending').length >= 3) return fail('too many pending orders');
    if (k.total && G.list.filter((g) => g.kind === k.kind && ['sent', 'pending'].includes(g.status)).length >= k.total) return fail('gift sold out');
    const g = { id: G.list.length + 1, kind: k.kind, serial: null, sender: uid, recipient: r.id, message: msg, anonymous: !!p_anon, hidden: false, status: 'pending', price: creator ? 0 : k.price, proof, created_at: now(), decided_at: null };
    if (creator) { g.status = 'sent'; g.serial = Math.max(0, ...G.list.filter((x) => x.kind === k.kind).map((x) => x.serial || 0)) + 1; g.decided_at = now(); }
    else logEvent('gift_order', '@' + prof(uid)?.username + ' хочет подарить «' + k.name + '» @' + r.username, 'orders');
    G.list.push(g); return g.id;
  },
  gifts_of: (uid, { p_user }) => GFT().list.filter((g) => g.recipient === p_user && g.status === 'sent' && (!g.hidden || g.recipient === uid))
    .map((g) => ({ id: g.id, kind: g.kind, serial: g.serial, sender: !g.anonymous || [g.recipient, g.sender].includes(uid) || prof(uid)?.role === 'creator' ? g.sender : null,
      message: [g.recipient, g.sender].includes(uid) ? g.message : null, anonymous: g.anonymous, hidden: g.hidden, created_at: g.decided_at || g.created_at })).reverse(),
  gift_hide: (uid, { p_id, p_hidden }) => { const g = GFT().list.find((x) => x.id === p_id && x.recipient === uid && x.status === 'sent'); if (!g) return fail('gift not found'); g.hidden = !!p_hidden; return null; },
  gifts_my_orders: (uid) => GFT().list.filter((g) => g.sender === uid && g.price > 0).map((g) => ({ id: g.id, kind: g.kind, recipient: prof(g.recipient)?.username, price: g.price, status: g.status, note: g.note || null, created_at: g.created_at })).reverse(),
  gift_cancel: (uid, { p_id }) => { const g = GFT().list.find((x) => x.id === p_id && x.sender === uid && x.status === 'pending'); if (!g) return fail('order not pending'); g.status = 'cancelled'; return null; },
  gifts_orders_admin: (uid) => prof(uid)?.role !== 'creator' ? fail('only creators') : GFT().list.filter((g) => g.status === 'pending')
    .map((g) => ({ id: g.id, kind: g.kind, sender: prof(g.sender)?.username, recipient: prof(g.recipient)?.username, price: g.price, proof: g.proof, message: g.message, anonymous: g.anonymous, created_at: g.created_at })),
  gift_decide: (uid, { p_id, p_ok, p_note }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators');
    const G = GFT(), g = G.list.find((x) => x.id === p_id && x.status === 'pending');
    if (!g) return fail('order not pending');
    if (p_ok) { g.status = 'sent'; g.serial = Math.max(0, ...G.list.filter((x) => x.kind === g.kind).map((x) => x.serial || 0)) + 1; g.decided_at = now(); }
    else { g.status = 'rejected'; g.note = p_note || null; }
    return null;
  },
  gift_set: (uid, { p_kind, p_price, p_total, p_active }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators');
    const k = GFT().kinds.find((x) => x.kind === p_kind); if (!k) return fail('no such gift');
    if (!(p_price >= 1)) return fail('bad price');
    Object.assign(k, { price: p_price, total: p_total ?? null, active: p_active ?? k.active }); return null;
  },
  // ---- Премиум (update-21) ----
  premium_list: () => PRM().users.filter((p) => new Date(p.until) > new Date()).map((p) => ({ user_id: p.user_id, nick_color: p.nick_color })),
  premium_me: (uid) => { const p = PRM().users.find((x) => x.user_id === uid); return [{ until: p?.until || null, nick_color: p?.nick_color || null, price_month: 2000, price_year: 24000 }]; },
  premium_order: (uid, { p_months, p_proof }) => {
    const proof = String(p_proof || '').trim();
    if (![1, 12].includes(p_months)) return fail('bad premium term');
    if (proof.length < 5 || proof.length > 300) return fail('bad proof');
    if (PRM().orders.some((o) => o.buyer === uid && o.status === 'pending')) return fail('order already pending');
    PRM().orders.push({ id: PRM().orders.length + 1, buyer: uid, months: p_months, price: p_months === 12 ? 24000 : 2000, proof, status: 'pending', note: null, created_at: now() });
    logEvent('order_premium', 'Заявка на Премиум (' + (p_months === 12 ? 'год' : 'месяц') + ') от @' + prof(uid)?.username + ' — ' + (p_months === 12 ? '24 000' : '2 000') + ' ₽', 'orders');
    return PRM().orders.length;
  },
  premium_cancel: (uid, { p_id }) => { const o = PRM().orders.find((x) => x.id === p_id && x.buyer === uid && x.status === 'pending'); if (!o) return fail('order not found'); o.status = 'cancelled'; return null; },
  premium_my_orders: (uid) => PRM().orders.filter((o) => o.buyer === uid).map(({ id, months, price, status, note, created_at }) => ({ id, months, price, status, note, created_at })).reverse(),
  premium_orders_admin: (uid) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators');
    return PRM().orders.filter((o) => o.status === 'pending').map((o) => ({ id: o.id, buyer: prof(o.buyer)?.username, months: o.months, price: o.price, proof: o.proof, created_at: o.created_at, has_until: PRM().users.find((x) => x.user_id === o.buyer)?.until || null }));
  },
  premium_decide: (uid, { p_id, p_ok, p_note }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators');
    const o = PRM().orders.find((x) => x.id === p_id && x.status === 'pending');
    if (!o) return fail('order not found');
    if (p_ok) { premExtend(o.buyer, o.months * 30); o.status = 'approved'; } else { o.status = 'rejected'; o.note = p_note || null; }
    return null;
  },
  premium_grant: (uid, { p_username, p_days }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators');
    const p = db.profiles.find((x) => x.username === String(p_username).replace(/^@/, '').trim().toLowerCase());
    if (!p) return fail('user not found');
    if (!p_days || p_days <= 0) PRM().users = PRM().users.filter((x) => x.user_id !== p.id); else premExtend(p.id, p_days);
    return null;
  },
  set_nick_color: (uid, { p_color }) => {
    const p = PRM().users.find((x) => x.user_id === uid && new Date(x.until) > new Date());
    if (!p) return fail('premium only');
    p.nick_color = p_color || null; return null;
  },
  // ---- магазин лимиток (update-19) ----
  // ---- «Фортуна» (update-26). db.fortune.force — что выпадет следующим (для тестов), иначе пусто ----
  fortune_state: (uid) => { const F = FRT(); return [{ active: F.active(), starts_at: F.starts, ends_at: F.ends, free_left: F.freeLeft(uid), paid_left: F.bal[uid] || 0, spin_price: 100, pack_size: 10, pack_price: 900, next_free: now() }]; },
  fortune_prizes_list: () => FRT().prizes.map(([kind, chance_bp]) => { const k = LTD().kinds.find((x) => x.kind === kind); return { kind, chance_bp, total: k.total, given: LTD().items.filter((i) => i.kind === kind).length, price: k.price, buyable: kind !== 'l_luck' }; }),
  fortune_spin: (uid) => {
    const F = FRT(), L = LTD();
    if (!F.active()) return fail('fortune is over');
    let paid = false;
    if (F.freeLeft(uid) > 0) {} else if ((F.bal[uid] || 0) > 0) { paid = true; F.bal[uid]--; } else return fail('no spins left');
    let won = F.force.length ? F.force.shift() : null, serial = null, item = null;
    if (won) {
      const k = L.kinds.find((x) => x.kind === won);
      if (L.items.filter((i) => i.kind === won).length >= k.total) won = null;
      else { serial = L.items.filter((i) => i.kind === won).length + 1; item = { id: L.items.length + 1, kind: won, serial, owner: uid, sale_price: null, acquired_at: now() }; L.items.push(item); }
    }
    F.spins.push({ user_id: uid, paid, kind: won, created_at: now() });
    return [{ kind: won, serial, item_id: item?.id || null, free_left: F.freeLeft(uid), paid_left: F.bal[uid] || 0 }];
  },
  fortune_my_spins: (uid) => FRT().spins.filter((x) => x.user_id === uid).reverse(),
  fortune_order: (uid, { p_spins, p_proof }) => {
    const F = FRT(), proof = String(p_proof || '').trim();
    if (!F.active()) return fail('fortune is over');
    if (!(p_spins >= 1 && p_spins <= 10000)) return fail('bad spins count');
    if (proof.length < 5) return fail('bad proof');
    const o = { id: F.orders.length + 1, buyer: uid, spins: p_spins, price: Math.floor(p_spins / 10) * 900 + (p_spins % 10) * 100, proof, status: 'pending', note: null, created_at: now() };
    F.orders.push(o); return o.id;
  },
  fortune_my_orders: (uid) => FRT().orders.filter((o) => o.buyer === uid).reverse(),
  fortune_cancel: (uid, { p_id }) => { const o = FRT().orders.find((x) => x.id === p_id && x.buyer === uid && x.status === 'pending'); if (o) o.status = 'cancelled'; return null; },
  fortune_orders_admin: (uid) => prof(uid)?.role !== 'creator' ? fail('only creators') : FRT().orders.filter((o) => o.status === 'pending').map((o) => ({ ...o, buyer: prof(o.buyer)?.username })),
  fortune_decide: (uid, { p_id, p_ok }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators');
    const F = FRT(), o = F.orders.find((x) => x.id === p_id);
    if (!o || o.status !== 'pending') return fail('order not pending');
    o.status = p_ok ? 'approved' : 'rejected'; if (p_ok) F.bal[o.buyer] = (F.bal[o.buyer] || 0) + o.spins; return null;
  },
  limited_catalog: () => LTD().kinds.map((k) => ({ kind: k.kind, price: k.price, total: k.total, sold: LTD().items.filter((i) => i.kind === k.kind).length,
    pending: LTD().orders.filter((o) => o.kind === k.kind && o.status === 'pending' && !o.resale).length })),
  limited_market: () => LTD().items.filter((i) => i.sale_price != null).map((i) => ({ item_id: i.id, kind: i.kind, serial: i.serial, seller: i.owner, price: i.sale_price,
    reserved: LTD().orders.some((o) => o.item_id === i.id && o.status === 'pending') })),
  limited_mine: (uid) => LTD().items.filter((i) => i.owner === uid).map((i) => ({ item_id: i.id, kind: i.kind, serial: i.serial, sale_price: i.sale_price, acquired_at: i.acquired_at,
    reserved: LTD().orders.some((o) => o.item_id === i.id && o.status === 'pending') })),
  limited_my_orders: (uid) => LTD().orders.filter((o) => o.buyer === uid).map((o) => ({ id: o.id, kind: o.kind, resale: o.resale, price: o.price, status: o.status, note: o.note, created_at: o.created_at })).reverse(),
  limited_requests: (uid) => LTD().orders.filter((o) => o.resale && o.status === 'pending' && o.seller === uid).map((o) => ({ id: o.id, kind: o.kind, serial: LTD().items.find((i) => i.id === o.item_id)?.serial, buyer: o.buyer, price: o.price, proof: o.proof, created_at: o.created_at })),
  limited_order: (uid, { p_kind, p_item, p_proof }) => {
    const L = LTD(), proof = String(p_proof || '').trim();
    if (proof.length > 300 || (p_item == null && proof.length < 5)) return fail('bad proof');
    if (L.orders.filter((o) => o.buyer === uid && o.status === 'pending').length >= 3) return fail('too many pending orders');
    const o = { id: L.orders.length + 1, buyer: uid, proof, status: 'pending', note: null, created_at: now(), resale: false, seller: null, item_id: null };
    if (p_item == null) {
      const k = L.kinds.find((x) => x.kind === p_kind);
      if (!k) return fail('no such limited');
      if (k.kind === 'l_luck') return fail('not for sale');
      if (k.kind.match(/^l_(clover|horseshoe|dice|burmalda|jackpot)$/) && !FRT().active()) return fail('fortune is over');
      if (L.orders.some((x) => x.buyer === uid && x.kind === k.kind && x.status === 'pending' && !x.resale)) return fail('order already pending');
      if (L.items.filter((i) => i.kind === k.kind).length + L.orders.filter((x) => x.kind === k.kind && x.status === 'pending' && !x.resale).length >= k.total) return fail('limited sold out');
      Object.assign(o, { kind: k.kind, price: isPrem(uid) ? Math.round(k.price * 0.9) : k.price });
    } else {
      const it = L.items.find((i) => i.id === p_item);
      if (!it || it.sale_price == null) return fail('not for sale');
      if (it.owner === uid) return fail('own item');
      if (L.orders.some((x) => x.item_id === it.id && x.status === 'pending')) return fail('item reserved');
      Object.assign(o, { kind: it.kind, price: it.sale_price, resale: true, seller: it.owner, item_id: it.id });
    }
    L.orders.push(o); return o.id;
  },
  limited_cancel: (uid, { p_id }) => { const o = LTD().orders.find((x) => x.id === p_id && x.buyer === uid && x.status === 'pending'); if (!o) return fail('order not found'); o.status = 'cancelled'; return null; },
  limited_sell: (uid, { p_item, p_price }) => {
    const it = LTD().items.find((i) => i.id === p_item && i.owner === uid);
    if (!it) return fail('item not found');
    if (LTD().orders.some((x) => x.item_id === it.id && x.status === 'pending')) return fail('item reserved');
    if (p_price != null && (p_price < 100 || p_price > 10000000)) return fail('bad price');
    it.sale_price = p_price ?? null; return null;
  },
  limited_orders_admin: (uid, { p_all }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators');
    return LTD().orders.filter((o) => !o.resale && (p_all || o.status === 'pending')).map((o) => ({ id: o.id, kind: o.kind, buyer: prof(o.buyer)?.username, price: o.price, proof: o.proof, status: o.status, note: o.note, created_at: o.created_at }));
  },
  limited_decide: (uid, { p_id, p_ok, p_note }) => {
    const L = LTD(), o = L.orders.find((x) => x.id === p_id && x.status === 'pending');
    if (!o || !(o.resale ? o.seller === uid : prof(uid)?.role === 'creator')) return fail('order not found');
    if (!p_ok) { o.status = 'rejected'; o.note = p_note || null; return null; }
    if (!o.resale) {
      const k = L.kinds.find((x) => x.kind === o.kind), same = L.items.filter((i) => i.kind === o.kind);
      if (same.length >= k.total) return fail('limited sold out');
      const it = { id: L.items.length + 1, kind: o.kind, serial: Math.max(0, ...same.map((i) => i.serial)) + 1, owner: o.buyer, sale_price: null, acquired_at: now() };
      L.items.push(it); o.item_id = it.id;
    } else {
      const it = L.items.find((i) => i.id === o.item_id);
      if (!it || it.owner !== o.seller || it.sale_price == null) return fail('listing changed');
      Object.assign(it, { owner: o.buyer, sale_price: null, acquired_at: now() });
    }
    o.status = 'approved'; return null;
  },
  limited_set: (uid, { p_kind, p_price, p_total }) => {
    if (prof(uid)?.role !== 'creator') return fail('only creators');
    const k = LTD().kinds.find((x) => x.kind === p_kind);
    if (!k) return fail('no such limited');
    if (p_total < LTD().items.filter((i) => i.kind === p_kind).length) return fail('total below sold');
    k.price = p_price; k.total = p_total; return null;
  },
  badges_list: () => {
    const relay = [...new Set(db.turn_providers.filter((t) => t.status === 'active').map((t) => t.owner))];
    return [...relay.map((u) => ({ user_id: u, kind: 'relay', granted: false })),
      ...db.badge_grants.filter((g) => !(g.kind === 'relay' && relay.includes(g.user_id))).map((g) => ({ user_id: g.user_id, kind: g.kind, granted: true })),
      ...db.moderators.filter((m) => activeMod(m.user_id) && modLevel(m.user_id)).map((m) => ({ user_id: m.user_id, kind: m.level, granted: true })),
      ...PRM().users.filter((p) => new Date(p.until) > new Date()).map((p) => ({ user_id: p.user_id, kind: 'premium', granted: false })),
      ...[...new Set(LTD().items.map((i) => i.owner + '|' + i.kind))].map((x) => ({ user_id: x.split('|')[0], kind: x.split('|')[1], granted: false }))];
  },
  touch_seen: (uid) => { const r = db.last_seen.find((x) => x.user_id === uid); if (r) r.seen_at = now(); else db.last_seen.push({ user_id: uid, seen_at: now(), hidden: false }); return null; },
  seen_of: (uid, { p_ids }) => db.last_seen.filter((s) => p_ids.includes(s.user_id)).map((s) => ({ user_id: s.user_id, seen_at: s.seen_at, recently: true, hidden: s.hidden })),
  set_hide_seen: (uid, { p_hidden }) => { RPC.touch_seen(uid); db.last_seen.find((x) => x.user_id === uid).hidden = p_hidden; return null; },
  report_node: () => null, save_push_subscription: () => null, is_member: (uid, { conv: id }) => isMember(uid, id),
  delete_account: (uid) => null,
};

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
function body(req) { return new Promise((res) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => res(Buffer.concat(ch))); }); }
const send = (res, code, obj, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    let p = path.join(ROOT, decodeURIComponent(url.pathname));
    if (p.endsWith('/')) p += 'index.html';
    if (!p.startsWith(ROOT) || !fs.existsSync(p)) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(p), MIME[path.extname(p)] || 'application/octet-stream');
  }
  const raw = await body(req);
  const j = raw.length && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : {};
  const cid = url.searchParams.get('c');
  const client = clients.get(cid) || (cid && clients.set(cid, { uid: null, queue: [], wait: null, subs: [] }).get(cid));
  const uid = url.searchParams.get('uid') || client?.uid || null;
  if (client && uid) client.uid = uid;

  switch (url.pathname) {
    case '/api/signup': {
      if (db.users.some((u) => u.email === j.email)) return send(res, 200, fail('User already registered'));
      if (db.profiles.some((p) => p.username === j.username)) return send(res, 200, fail('Database error saving new user'));
      const u = { id: uuid(), email: j.email, password: j.password };
      db.users.push(u); db.profiles.push({ id: u.id, username: j.username, display_name: null, avatar_hue: null, role: j.role || null, frame: null, avatar_path: null, created_at: now() });
      return send(res, 200, { data: { id: u.id, email: u.email, user_metadata: { username: j.username } } });
    }
    case '/api/login': {
      const u = db.users.find((x) => x.email === j.email && x.password === j.password);
      if (!u) return send(res, 200, fail('Invalid login credentials'));
      if (db.bans.some((b) => b.user_id === u.id)) return send(res, 200, fail('User is banned'));
      return send(res, 200, { data: { id: u.id, email: u.email, user_metadata: { username: prof(u.id).username } } });
    }
    case '/api/password': { const u = db.users.find((x) => x.id === uid); if (u) u.password = j.password; return send(res, 200, { data: {} }); }
    case '/api/q': {
      // тест: медленный/падающий сервер для вставки сообщений
      if (j.table === 'messages' && j.op === 'insert' && slow.ms) await new Promise((r) => setTimeout(r, slow.ms));
      if (j.table === 'messages' && j.op === 'insert' && slow.fail) return send(res, 200, { data: null, error: { message: 'Failed to fetch' } });
      return send(res, 200, query(uid, j));
    }
    case '/api/slow': slow.ms = j.ms || 0; slow.fail = !!j.fail; return send(res, 200, { ok: true });
    case '/api/rpc': {
      const f = RPC[j.fn];
      if (!f) return send(res, 200, fail(`Could not find the function public.${j.fn}`));
      const out = f(uid, j.args || {});
      return send(res, 200, out && out.error ? out : { data: out ?? null });
    }
    case '/api/storage/upload': {
      const key = url.searchParams.get('b') + '/' + url.searchParams.get('p');
      if (files.has(key)) return send(res, 200, fail('The resource already exists'));
      files.set(key, { bytes: raw, owner: uid, type: req.headers['content-type'] });
      return send(res, 200, { data: { path: url.searchParams.get('p') } });
    }
    case '/api/storage/download': {
      const f = files.get(url.searchParams.get('b') + '/' + url.searchParams.get('p'));
      if (!f) return send(res, 404, 'missing', 'text/plain');
      res.writeHead(200, { 'Content-Type': f.type || 'application/octet-stream' }); return res.end(f.bytes);
    }
    case '/api/storage/remove': {
      const out = [];
      for (const p of j.paths) { const k = j.bucket + '/' + p, f = files.get(k); if (f && f.owner === uid) { files.delete(k); out.push({ name: p }); } }
      return send(res, 200, { data: out });
    }
    case '/api/storage/list': {
      const pre = j.bucket + '/' + j.prefix + '/';
      return send(res, 200, { data: [...files.keys()].filter((k) => k.startsWith(pre)).map((k) => ({ name: k.slice(pre.length) })) });
    }
    case '/api/subscribe': { client.subs = client.subs.filter((s) => s.topic !== j.topic).concat(j.subs.map((s) => ({ ...s, topic: j.topic }))); return send(res, 200, { ok: true }); }
    case '/api/unsubscribe': {
      client.subs = client.subs.filter((s) => s.topic !== j.topic);
      const pm = presence.get(j.topic); if (pm) for (const [k, v] of pm) if (v === cid) { pm.delete(k); presenceSync(j.topic); }
      return send(res, 200, { ok: true });
    }
    case '/api/broadcast': {
      for (const [ocid, c] of clients) {
        if (ocid === cid) continue;
        // как в жизни: доставка с разной задержкой, порядок сообщений может перепутаться
        for (const s of c.subs) if (s.topic === j.topic && s.kind === 'broadcast' && s.event === j.event) {
          const ev = { topic: j.topic, type: 'broadcast', event: j.event, payload: j.payload };
          setTimeout(() => push(ocid, ev), JITTER ? Math.random() * JITTER : 0);
        }
      }
      return send(res, 200, { ok: true });
    }
    case '/api/presence': {
      if (!presence.has(j.topic)) presence.set(j.topic, new Map());
      const pm = presence.get(j.topic);
      if (j.track) pm.set(j.key, cid); else pm.delete(j.key);
      presenceSync(j.topic);
      return send(res, 200, { ok: true });
    }
    case '/api/poll': {
      if (!client.queue.length) await new Promise((r) => { client.wait = r; setTimeout(r, 20000); });
      const q = client.queue; client.queue = [];
      return send(res, 200, q);
    }
    case '/api/fn/turn-check': {
      const t = db.turn_providers.find((x) => x.id === j.id);
      if (!t) return send(res, 200, { data: { checked: 0, results: [] } });
      const ok = t.username === 'good';
      Object.assign(t, ok ? { status: 'active', last_ok: now(), last_error: null } : { status: 'failing', last_error: 'неверный логин или пароль' });
      const s = db.partner_state.find((x) => x.user_id === t.owner);
      if (s) { s.turn_active = db.turn_providers.some((x) => x.owner === t.owner && x.status === 'active'); s.silver_since = s.turn_active ? (s.silver_since || now()) : null; s.tier = s.turn_active ? 'silver' : 'bronze'; }
      return send(res, 200, { data: { checked: 1, results: [{ id: t.id, ok, error: t.last_error }] } });
    }
    case '/api/grant': { const p = db.profiles.find((x) => x.username === j.username); db.badge_grants.push({ user_id: p.id, kind: j.kind, since: now() }); return send(res, 200, { ok: true }); }
    case '/api/mod': { const p = db.profiles.find((x) => x.username === j.username); db.moderators = db.moderators.filter((m) => m.user_id !== p.id); if (j.level) db.moderators.push({ user_id: p.id, level: j.level, until: j.seconds ? new Date(Date.now() + j.seconds * 1000).toISOString() : null, by_user: null }); return send(res, 200, { ok: true }); }
    case '/api/avatar': { const p = db.profiles.find((x) => x.username === j.username); p.avatar_path = j.path; return send(res, 200, { ok: true }); }
    case '/api/reports': return send(res, 200, { data: db.call_reports });
    case '/api/fortune': { const F = FRT(); if (j.force) F.force.push(...j.force); if ('off' in j) F.off = !!j.off; return send(res, 200, { ok: true }); }
    case '/api/event': { logEvent(j.kind || 'user_new', j.text, j.go || null); return send(res, 200, { ok: true }); }
    case '/api/role': { const p = db.profiles.find((x) => x.username === j.username); p.role = j.role; return send(res, 200, { ok: true }); }
    case '/api/partner': {   // тест: сделать человека партнёром (узел)
      const p = db.profiles.find((x) => x.username === j.username);
      db.partner_state = db.partner_state.filter((x) => x.user_id !== p.id);
      db.partner_state.push({ user_id: p.id, active: true, since: now(), msgs: 0, score: 0, turn_active: false, silver_since: j.silver_since || null, tier: j.tier || 'bronze' });
      return send(res, 200, { ok: true });
    }
    case '/api/debug': return send(res, 200, { db, files: [...files.keys()] });
    case '/api/reset': for (const k of Object.keys(db)) db[k] = []; files.clear(); return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'no route' });
}).listen(PORT, () => console.log('mock on', PORT));

function presenceSync(topic) {
  const pm = presence.get(topic) || new Map();
  const state = Object.fromEntries([...pm.keys()].map((k) => [k, [{ at: 1 }]]));
  for (const [ocid, c] of clients) for (const s of c.subs) if (s.topic === topic && s.kind === 'presence') push(ocid, { topic, type: 'presence', state });
}
