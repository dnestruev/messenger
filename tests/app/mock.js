// Заглушка supabase-js для тестов: тот же интерфейс, что использует приложение, но всё идёт на server.mjs
const CID = Math.random().toString(36).slice(2);
let session = null;
try { session = JSON.parse(localStorage.getItem('mock-session') || 'null'); } catch {}
const listeners = [];
const api = async (p, body, extra = '') => {
  const r = await fetch(`/api/${p}?c=${CID}${session ? '&uid=' + session.user.id : ''}${extra}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return r.json();
};
window.__mockApi = api;
const emit = (ev) => listeners.forEach((f) => f(ev, session));
const setSession = (user) => {
  session = user ? { user, access_token: 'tok-' + user.id } : null;
  if (session) localStorage.setItem('mock-session', JSON.stringify(session)); else localStorage.removeItem('mock-session');
};

class Query {
  constructor(table) { this.q = { table, op: 'select', filters: [] }; }
  select() { if (this.q.op === 'select') this.q.op = 'select'; this.q.returning = true; return this; }
  insert(values) { this.q.op = 'insert'; this.q.values = values; return this; }
  upsert(values, o = {}) { this.q.op = 'upsert'; this.q.values = values; this.q.onConflict = o.onConflict; return this; }
  update(values) { this.q.op = 'update'; this.q.values = values; return this; }
  delete() { this.q.op = 'delete'; return this; }
  eq(c, v) { this.q.filters.push(['eq', c, v]); return this; }
  neq(c, v) { this.q.filters.push(['neq', c, v]); return this; }
  in(c, v) { this.q.filters.push(['in', c, v]); return this; }
  lt(c, v) { this.q.filters.push(['lt', c, v]); return this; }
  gt(c, v) { this.q.filters.push(['gt', c, v]); return this; }
  order(col, o = {}) { this.q.order = { col, asc: o.ascending !== false }; return this; }
  limit(n) { this.q.limit = n; return this; }
  single() { this.q.single = true; return this; }
  maybeSingle() { this.q.single = true; this.q.maybe = true; return this; }
  then(ok, bad) { return api('q', this.q).then((r) => ({ data: r.data ?? null, error: r.error || null })).then(ok, bad); }
}

class Channel {
  constructor(topic, opts) { this.topic = topic; this.subs = []; this.handlers = []; this.presenceKey = opts?.config?.presence?.key; this.state = {}; }
  on(kind, filter, cb) {
    const id = this.handlers.length;
    this.handlers.push({ kind, filter, cb });
    if (kind === 'postgres_changes') this.subs.push({ kind: 'pg', id, table: filter.table, event: filter.event, filter: filter.filter });
    if (kind === 'broadcast') this.subs.push({ kind: 'broadcast', event: filter.event });
    if (kind === 'presence') this.subs.push({ kind: 'presence' });
    return this;
  }
  subscribe(cb) { channels.add(this); api('subscribe', { topic: this.topic, subs: this.subs }).then(() => cb?.('SUBSCRIBED')); return this; }
  async send({ event, payload }) { await api('broadcast', { topic: this.topic, event, payload }); return 'ok'; }
  track() { return api('presence', { topic: this.topic, key: this.presenceKey, track: true }); }
  untrack() { return api('presence', { topic: this.topic, key: this.presenceKey, track: false }); }
  presenceState() { return this.state; }
  deliver(ev) {
    if (ev.type === 'pg') { const h = this.handlers[ev.id]; h?.cb(ev.payload); return; }
    if (ev.type === 'presence') { this.state = ev.state; for (const h of this.handlers) if (h.kind === 'presence') h.cb({}); return; }
    for (const h of this.handlers) if (h.kind === 'broadcast' && h.filter.event === ev.event) h.cb({ payload: ev.payload });
  }
}
const channels = new Set();
(async function poll() {
  for (;;) {
    try {
      const evs = await (await fetch(`/api/poll?c=${CID}${session ? '&uid=' + session.user.id : ''}`, { method: 'POST' })).json();
      for (const ev of evs) for (const ch of channels) if (ch.topic === ev.topic) { try { ch.deliver(ev); } catch (e) { console.error(e); } }
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
})();

export function createClient() {
  return {
    auth: {
      async getSession() { return { data: { session } }; },
      onAuthStateChange(f) { listeners.push(f); setTimeout(() => f('INITIAL_SESSION', session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithPassword({ email, password }) {
        const r = await api('login', { email, password });
        if (r.error) return { error: r.error };
        setSession(r.data); emit('SIGNED_IN'); return { data: { session }, error: null };
      },
      async signUp({ email, password, options }) {
        const r = await api('signup', { email, password, username: options.data.username });
        if (r.error) return { error: r.error };
        setSession(r.data); emit('SIGNED_IN'); return { data: { session, user: r.data }, error: null };
      },
      async signOut() { setSession(null); emit('SIGNED_OUT'); return { error: null }; },
      async updateUser({ password }) { await api('password', { password }); return { data: {}, error: null }; },
      async resetPasswordForEmail() { window.__resetAsked = true; return { data: {}, error: null }; },
    },
    from: (t) => new Query(t),
    rpc: (fn, args) => api('rpc', { fn, args }).then((r) => ({ data: r.data ?? null, error: r.error || null })),
    channel: (topic, opts) => new Channel(topic, opts),
    removeChannel(ch) { channels.delete(ch); api('unsubscribe', { topic: ch.topic }); },
    storage: {
      from: (bucket) => ({
        async upload(p, blob, o = {}) {
          const r = await fetch(`/api/storage/upload?c=${CID}&uid=${session?.user.id}&b=${bucket}&p=${encodeURIComponent(p)}`, { method: 'POST', headers: { 'Content-Type': o.contentType || 'application/octet-stream' }, body: blob });
          const j = await r.json(); return { data: j.data, error: j.error || null };
        },
        async download(p) {
          const r = await fetch(`/api/storage/download?b=${bucket}&p=${encodeURIComponent(p)}`, { method: 'POST' });
          return r.ok ? { data: await r.blob(), error: null } : { data: null, error: { message: 'Object not found' } };
        },
        async remove(paths) { const r = await api('storage/remove', { bucket, paths }); return { data: r.data, error: null }; },
        async list(prefix) { const r = await api('storage/list', { bucket, prefix }); return { data: r.data, error: null }; },
      }),
    },
  };
}
