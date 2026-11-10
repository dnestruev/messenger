import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('../../js/main.js', import.meta.url), 'utf8');
function setup() {
  const timers = new Map(), sent = [], added = [];
  let tid = 0, sid = 0, subscriptions = 0;
  const ctx = vm.createContext({
    CONFIG: {}, uuid: () => `id-${++sid}`, Date, Set, Map, Promise,
    state: { me: { id: 'me' }, chats: new Map([['chat', {}]]) },
    otherOf: () => 'peer', currentVersion: () => 1, chatKey: () => 'key',
    E2E: { sealJson: async (_, msg) => ({ ct: msg }), openJson: async (_, msg) => msg },
    sb: { channel: () => ({ subscribe(cb) { subscriptions++; Promise.resolve().then(() => cb('SUBSCRIBED')); },
      send: async (msg) => { sent.push(msg.payload.ct); return 'ok'; } }), removeChannel() {} },
    setTimeout: (f, ms) => { timers.set(++tid, { f, ms }); return tid; },
    clearTimeout: (id) => timers.delete(id), clearInterval() {}, setInterval() {},
    MediaStream: class {}, RTCPeerConnection: class {
      async addIceCandidate(c) { added.push(c); }
      async setRemoteDescription(sdp) { this.remoteDescription = sdp; }
    },
  });
  vm.runInContext(source.slice(source.indexOf('const ICE_SERVERS ='), source.indexOf('/* ---------- Экран звонка')), ctx);
  vm.runInContext(`
    stopTone = () => {}; updateCallUi = () => {}; setCallStatus = () => {};
    finishCall = (status) => { globalThis.finished = status; call = null; };
    globalThis.setCall = (c) => call = c;
    globalThis.getCall = () => call;
    globalThis.signal = (msg) => onSignal({ from: 'peer', conv: 'chat', kv: 1, ct: { ts: Date.now(), id: 'c', ...msg } });
  `, ctx);
  return { ctx, timers, sent, added, subscriptions: () => subscriptions };
}

test('parallel signals share one subscription and have unique IDs', async () => {
  const { ctx, sent, subscriptions } = setup();
  await vm.runInContext(`Promise.all([sendSignal('chat','peer',{t:'ice'}),sendSignal('chat','peer',{t:'ice'})])`, ctx);
  assert.equal(subscriptions(), 1);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].sid, sent[1].sid);
});

test('late ICE is sent, saved and replayed after recipient starts ringing', async () => {
  const { ctx, sent } = setup();
  vm.runInContext(`const p = makePeer(); call = { ...p, id: 'c', conv: 'chat', peer: 'peer', dir: 'out' };
    p.pc.onicecandidate({ candidate: { toJSON: () => ({ candidate: 'late' }) } });`, ctx);
  await ctx.signal({ t: 'ring', sid: 'ring' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.filter(m => m.t === 'ice').length, 2);
  assert.equal(ctx.getCall().localIce[0].candidate, 'late');
});

test('ICE waits for answer; duplicates and candidates from other devices are ignored', async () => {
  const { ctx, added } = setup();
  vm.runInContext(`call = { ...makePeer(), id:'c', conv:'chat', peer:'peer', dir:'out' };`, ctx);
  await ctx.signal({ t: 'ice', dev: 'other', sid: '1', candidate: { candidate: 'wrong' } });
  await ctx.signal({ t: 'ice', dev: 'chosen', sid: '2', candidate: { candidate: 'right' } });
  await ctx.signal({ t: 'ice', dev: 'chosen', sid: '3', candidate: { candidate: 'right' } });
  assert.equal(added.length, 0);
  await ctx.signal({ t: 'answer', dev: 'chosen', sid: '4', sdp: 'answer' });
  assert.deepEqual(added, [{ candidate: 'right' }]);
  await ctx.signal({ t: 'ice', dev: 'chosen', sid: '5', candidate: { candidate: 'late' } });
  assert.equal(added.length, 2);
});

test('connection timeout finishes stuck calls but cannot end a replacement call', () => {
  const { ctx, timers } = setup();
  ctx.setCall({});
  vm.runInContext('connectionDeadline(call)', ctx);
  const expire = [...timers.values()][0];
  assert.equal(expire.ms, 30000);
  expire.f();
  assert.equal(ctx.finished, 'failed');
  ctx.finished = null;
  ctx.setCall({});
  vm.runInContext('connectionDeadline(call)', ctx);
  const stale = [...timers.values()].at(-1).f;
  const replacement = {};
  ctx.setCall(replacement); stale();
  assert.equal(ctx.getCall(), replacement);
  assert.equal(ctx.finished, null);
});

test('repeated setup cannot extend the connection deadline', () => {
  const { ctx, timers } = setup();
  ctx.setCall({});
  vm.runInContext('connectionDeadline(call); connectionDeadline(call)', ctx);
  assert.equal(timers.size, 1);
});

test('call screen closes and media stops even if sound and title cleanup throw', () => {
  const { ctx, timers } = setup();
  vm.runInContext(source.slice(source.indexOf('function finishCall('), source.indexOf('/* ---------- Экран звонка')), ctx);
  let ending = false, removed = false, stopped = false, closed = false;
  ctx.fmtDur = () => '0:00';
  ctx.navigator = {};
  ctx.swReg = null;
  vm.runInContext("stopTone = () => { throw Error('audio'); }; stopTitle = () => { throw Error('title'); };", ctx);
  const status = {};
  ctx.setCall({ id: 'c', dir: 'in', pc: { close() { closed = true; } },
    local: { getTracks: () => [{ stop() { stopped = true; } }] },
    ui: { root: { classList: { add() { ending = true; } }, remove() { removed = true; } },
      status, controls: { replaceChildren() {} } } });
  vm.runInContext("finishCall('failed', { remote: true, silent: true })", ctx);
  assert.equal(ctx.getCall(), null);
  assert.ok(ending && stopped && closed);
  assert.equal(status.textContent, 'Не удалось соединиться');
  [...timers.values()].find(t => t.ms === 900).f();
  assert.ok(removed);
});
