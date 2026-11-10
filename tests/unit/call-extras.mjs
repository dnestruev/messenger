import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.location = { search: '?calltest=1' };
const code = readFileSync(new URL('../../js/call-extras.js', import.meta.url), 'utf8');
const { createCallExtras, prepareVideo, CALL_BETA } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const track = kind => ({ kind, enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; }, async applyConstraints(c) { this.constraints = c; } });
function setup(camera = true) {
  const mic = track('audio'), cam = camera ? track('video') : null, display = track('video');
  const video = { track: cam, async replaceTrack(t) { this.track = t; }, getParameters: () => ({ encodings: [{}] }), async setParameters(p) { this.params = p; } };
  const audio = { track: mic, getParameters: () => ({ encodings: [{}] }), async setParameters(p) { this.params = p; } };
  const transceiver = { receiver: { track: { kind: 'video' } }, currentDirection: 'sendrecv', sender: video };
  const signals = [], notices = [];
  const stream = { getTracks: () => [display], getVideoTracks: () => [display] };
  const media = { getDisplayMedia: async () => stream };
  const cur = { pc: { getTransceivers: () => [transceiver], getSenders: () => [audio, video], getStats: async () => new Map() }, local: { getAudioTracks: () => [mic] } };
  const extras = createCallExtras(cur, { active: () => true, update() {}, signal: async s => signals.push(s), notice: s => notices.push(s), media });
  return { cur, extras, media, cam, mic, display, video, audio, signals, notices, transceiver };
}
test('test mode is explicit and defaults off', async () => {
  assert.equal(CALL_BETA, true);
  globalThis.location.search = '';
  const stable = await import('data:text/javascript;base64,' + Buffer.from(code + '\n// stable').toString('base64'));
  assert.equal(stable.CALL_BETA, false);
});
test('voice-only call reserves a sendrecv video transceiver', () => {
  let added;
  const pc = { getTransceivers: () => [], addTransceiver(kind, opts) { added = { kind, ...opts, sender: {} }; return added; } };
  assert.equal(prepareVideo(pc, true), added.sender);
  assert.equal(added.kind, 'video'); assert.equal(added.direction, 'sendrecv');
});
for (const camera of [true, false]) test(`screen replaces video and restores ${camera ? 'camera' : 'voice-only'}`, async () => {
  const s = setup(camera);
  await s.extras.startScreen();
  assert.equal(s.video.track, s.display); assert.equal(s.cur.sharingScreen, true);
  assert.equal(s.audio.params.encodings[0].maxBitrate, 48000);
  await s.extras.stopScreen();
  assert.equal(s.video.track, s.cam); assert.equal(s.display.readyState, 'ended');
  assert.equal(s.signals.at(-1).screen, false); assert.equal(s.mic.readyState, 'live');
});
test('cancelled picker leaves camera and audio untouched', async () => {
  const s = setup(); s.media.getDisplayMedia = async () => { throw Object.assign(Error(), { name: 'NotAllowedError' }); };
  await s.extras.startScreen(); assert.equal(s.video.track, s.cam); assert.equal(s.mic.readyState, 'live'); assert.equal(s.notices.length, 0);
});
test('hangup while picker is open stops late capture', async () => {
  const s = setup(); let resolve;
  s.media.getDisplayMedia = () => new Promise(r => { resolve = r; });
  const p = s.extras.startScreen(); s.extras.dispose();
  resolve({ getTracks: () => [s.display], getVideoTracks: () => [s.display] });
  await p; assert.equal(s.display.readyState, 'ended'); assert.equal(s.video.track, s.cam);
});
test('hangup stops active screen capture', async () => {
  const s = setup(); await s.extras.startScreen(); s.extras.dispose(); assert.equal(s.display.readyState, 'ended');
});
test('failed camera restoration still stops capture', async () => {
  const s = setup(); await s.extras.startScreen(); s.video.replaceTrack = async () => { throw Error('closed'); };
  await s.extras.stopScreen(); assert.equal(s.display.readyState, 'ended'); assert.equal(s.cur.sharingScreen, false);
});
test('voice preset keeps microphone mute and echo cancellation', async () => {
  const s = setup(); s.mic.enabled = false; await s.extras.toggleVoice();
  assert.equal(s.mic.enabled, false); assert.equal(s.mic.constraints.echoCancellation, true);
  assert.equal(s.mic.constraints.noiseSuppression, false);
});
test('sustained poor outgoing audio stats lower video load', async () => {
  const s = setup(); s.cur.pc.getStats = async () => new Map([['r', { id: 'r', type: 'remote-inbound-rtp', kind: 'audio', roundTripTime: 1, fractionLost: .1 }]]);
  await s.extras.poll(); await s.extras.poll();
  assert.equal(s.video.params.encodings[0].maxBitrate, 650000);
  assert.equal(s.cur.callQuality, 'Слабая связь');
  s.cur.pc.getStats = async () => new Map([['r', { id: 'r', type: 'remote-inbound-rtp', kind: 'audio', roundTripTime: .1, fractionLost: 0 }]]);
  for (let i = 0; i < 4; i++) await s.extras.poll();
  assert.equal(s.video.params.encodings[0].maxBitrate, 2500000);
});
