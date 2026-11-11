// npm install --prefix /tmp/roles-test @electric-sql/pglite
// PGLITE_MODULE=/tmp/roles-test/node_modules/@electric-sql/pglite/dist/index.js node tests/unit/moderation.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const ids = Object.fromEntries(['owner','skitle','peteroxhka','user','other_senior'].map((u,i) => [u, `00000000-0000-0000-0000-00000000000${i+1}`]));
await db.exec(`
create role anon; create role authenticated;
create schema auth; create schema storage;
create table auth.users(id uuid primary key, banned_until timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table public.profiles(id uuid primary key, username text unique, display_name text, role text, hidden_badges text[] default '{}', created_at timestamptz default now());
create table public.bans(user_id uuid primary key, reason text, until timestamptz, by_user uuid, created_at timestamptz default now());
create function public.is_creator(uid uuid) returns bool language sql stable security definer as $$ select exists(select 1 from public.profiles where id=uid and role='creator') $$;
create function public.is_banned(uid uuid) returns bool language sql stable security definer as $$ select exists(select 1 from public.bans where user_id=uid and (until is null or until>now())) $$;
create table public.app_settings(key text primary key, value text, updated_at timestamptz);
create table public.last_seen(user_id uuid, seen_at timestamptz);
create table public.badge_grants(user_id uuid, kind text);
create table public.nodes(owner uuid, status text);
create table public.turn_providers(owner uuid, status text, last_ok timestamptz);
create table public.messages(sender_id uuid, created_at timestamptz);
create table public.partner_state(user_id uuid, active bool, tier text);
create table public.conversations(is_group bool);
create table storage.objects(metadata jsonb);
create table public.call_reports(call_id uuid, status text, created_at timestamptz);
grant usage on schema public, auth to authenticated;
`);
for (const [name,id] of Object.entries(ids)) {
 await db.query('insert into public.profiles(id,username,role) values($1,$2,$3)',[id,name,name==='owner'?'creator':name==='peteroxhka'?'tester':null]);
 await db.query('insert into auth.users(id) values($1)',[id]);
}
const root = new URL('../../', import.meta.url);
const migration = readFileSync(new URL('update-18.sql',root),'utf8');
await db.exec(migration); await db.exec(migration); // idempotent schema
const assign = readFileSync(new URL('scripts/assign-moderators.sql',root),'utf8');
await db.exec(assign);
const first = (await db.query('select expires_at from moderation_roles where user_id=$1',[ids.peteroxhka])).rows[0].expires_at;
await db.exec(assign);
assert.equal(String((await db.query('select expires_at from moderation_roles where user_id=$1',[ids.peteroxhka])).rows[0].expires_at), String(first));
let checks=1;
async function as(name) {
 await db.exec('reset role');
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[name]]);
 await db.exec('set role authenticated');
}
async function deny(sql) { await assert.rejects(db.query(sql)); checks++; }
await as('skitle');
assert.equal((await db.query('select count(*)::int n from admin_users()')).rows[0].n,5); checks++;
assert.equal((await db.query('select admin_stats() s')).rows[0].s.users,5); checks++;
await deny("select set_moderation_role('user','senior_moderator',null)");
await deny("select set_app_setting('donate_url','https://example.com')");
await deny("select set_role('user','tester')");
await deny("select ban_user('owner',1,'x')");
await deny("select ban_user('peteroxhka',1,'x')");
await deny("update moderation_roles set expires_at=null");
await db.query("select ban_user('user',1,'x')"); await db.query("select unban_user('user')"); checks++;
await as('peteroxhka');
assert.equal((await db.query('select staff_rank(auth.uid()) r')).rows[0].r,2); checks++;
await db.query("select set_moderation_role('user','moderator',null)");
await db.query("select set_role('user','tester')");
await db.query("select set_app_setting('donate_url','https://example.com')"); checks++;
await deny("select set_moderation_role('user','senior_moderator',null)");
await deny("select set_moderation_role('peteroxhka','moderator',null)");
await deny("select set_app_setting('server_secret','x')");
await as('owner'); await db.query("select set_moderation_role('other_senior','senior_moderator',null)");
await db.query("select ban_user('other_senior',1,'x')");
await as('peteroxhka');
await deny("select set_moderation_role('other_senior','moderator',null)");
await deny("select set_role('other_senior','tester')");
await deny("select unban_user('other_senior')");
await db.exec('reset role');
await db.query("update moderation_roles set expires_at=now()-interval '1 second' where user_id=$1",[ids.peteroxhka]);
await as('peteroxhka');
assert.equal((await db.query('select staff_rank(auth.uid()) r')).rows[0].r,0); checks++;
await deny('select * from admin_users()');
await deny("select set_app_setting('donate_url','https://example.com')");
await deny("select set_role('user','tester')");
await deny("select ban_user('user',1,'x')");
await db.exec('reset role');
assert.equal((await db.query('select role from profiles where id=$1',[ids.peteroxhka])).rows[0].role,'tester'); checks++;
await db.close();
console.log(`${checks} PostgreSQL permission/expiry checks passed`);
