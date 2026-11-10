// Тестовый «Supabase» в памяти + раздача копии сайта. Запуск: node server.mjs <папка сайта> <порт>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.argv[2];
const PORT = +process.argv[3] || 8765;
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

const db = {
  users: [], profiles: [], user_keys: [], key_backups: [], conversations: [], conversation_members: [],
  conversation_keys: [], conversation_key_claims: [], messages: [], reactions: [], blocks: [], nodes: [],
  partner_gifts: [], partner_state: [], push_subscriptions: [], last_seen: [],
};
const files = new Map();        // bucket/path -> { bytes, owner, type }
let msgSeq = 1;
const clients = new Map();      // clientId -> { uid, queue: [], wait: null, subs: [], presence: {} }
const presence = new Map();     // topic -> Map(key -> clientId)

const isMember = (uid, conv) => db.conversation_members.some((m) => m.conversation_id === conv && m.user_id === uid);
const conv = (id) => db.conversations.find((c) => c.id === id);
const prof = (id) => db.profiles.find((p) => p.id === id);
const fail = (message, code = 400) => ({ error: { message, code }, status: code });

/* ---------- события ---------- */
function push(cid, ev) {
  const c = clients.get(cid);
  if (!c) return;
  c.queue.push(ev);
  if (c.wait) { const w = c.wait; c.wait = null; w(); }
}
/** postgres_changes: кому отправить — решает visible(uid) */
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
    default: return false;
  }
}
function beforeWrite(uid, table, r, old) {
  if (table === 'messages') {
    const c = conv(r.conversation_id);
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
const RPC = {
  username_available: (uid, { name }) => !db.profiles.some((p) => p.username === name.toLowerCase()),
  my_chats: (uid) => db.conversation_members.filter((m) => m.user_id === uid).map((m) => {
    const c = conv(m.conversation_id);
    const lm = db.messages.filter((x) => x.conversation_id === c.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    return { id: c.id, is_group: c.is_group, title: c.title, is_official: c.is_official, archived: m.archived, key_version: c.key_version, key_checks: c.key_checks,
      last_message_at: c.last_message_at, last_read_at: m.last_read_at, last_ct: lm?.ct ?? null, last_iv: lm?.iv ?? null, last_sender: lm?.sender_id ?? null,
      last_hash: lm?.ct_hash ?? null, last_nodes: lm?.nodes ?? null, last_cid: lm?.cid ?? null, last_sig: lm?.sig ?? null, last_key_version: lm?.key_version ?? null,
      member_ids: db.conversation_members.filter((x) => x.conversation_id === c.id).map((x) => x.user_id) };
  }),
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
    if (cl && cl.claimed_by !== uid && Date.now() - cl.at < 30000) return false;
    if (cl) { cl.claimed_by = uid; cl.at = Date.now(); } else db.conversation_key_claims.push({ conversation_id: id, version: v, claimed_by: uid, at: Date.now() });
    c.key_checks = { ...c.key_checks, [v]: p_check };
    return true;
  },
  perks_list: () => [], partner_top: () => [], node_stats: () => [],
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
      return send(res, 200, { data: { id: u.id, email: u.email, user_metadata: { username: prof(u.id).username } } });
    }
    case '/api/password': { const u = db.users.find((x) => x.id === uid); if (u) u.password = j.password; return send(res, 200, { data: {} }); }
    case '/api/q': return send(res, 200, query(uid, j));
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
        for (const s of c.subs) if (s.topic === j.topic && s.kind === 'broadcast' && s.event === j.event) push(ocid, { topic: j.topic, type: 'broadcast', event: j.event, payload: j.payload });
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
