// Проверки нового ICE-модуля. Запуск: node --test tests/calls-ice.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Репозиторий — статический веб-сайт, без package.json/type=module.
// Импортируем исходный ES-модуль как data URL, не меняя сборку браузера.
const code = readFileSync(new URL('../js/calls.js', import.meta.url), 'utf8');
const calls = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('Типы ICE-кандидатов не теряются при сериализации', () => {
  const candidates = [
    { candidate: 'candidate:1 1 udp 20 192.0.2.10 5000 typ host generation 0' },
    { candidate: 'candidate:2 1 udp 20 198.51.100.10 6000 typ srflx generation 0' },
    { candidate: 'candidate:3 1 udp 20 203.0.113.10 7000 typ relay generation 0' },
  ];
  assert.deepEqual(calls.candidateCounts(candidates), {
    host: 1, srflx: 1, prflx: 0, relay: 1, unknown: 0,
  });
  assert.equal(calls.candidateType(candidates[2]), 'relay');
});

test('TURN должен определяться по адресу, а не по числу кандидатов', () => {
  assert.equal(calls.hasTurn([{ urls: ['stun:stun.example.org'] }]), false);
  assert.equal(calls.hasTurn([{ urls: ['turns:turn.example.org:5349?transport=tcp'], username: 'test', credential: 'test' }]), true);
});

test('Выбранный маршрут определяется по getStats без раскрытия адресов', async () => {
  const stats = new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.07 }],
    ['local', { type: 'local-candidate', candidateType: 'relay', protocol: 'udp' }],
    ['remote', { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
  ]);
  const result = await calls.selectedRoute({ getStats: async () => stats });
  assert.equal(result, 'relay/udp → srflx/udp, RTT 70 мс');
});

test('Когда Edge Function недоступна, приложение сохраняет работу через STUN', async () => {
  const sb = { functions: { invoke: async () => { throw new Error('TURN не развернут'); } } };
  const cfg = await calls.loadIceConfiguration(sb);
  assert.equal(cfg.turnConfigured, false);
  assert.equal(calls.hasTurn(cfg.iceServers), false);
  assert.match(cfg.turnError, /TURN не развернут/);
});
