// Opt-in only: /?calltest=1. Removing the query restores the stable call path.
export const CALL_BETA = new URLSearchParams(location.search).get('calltest') === '1';

export function prepareVideo(pc, create = false) {
  let transceiver = pc.getTransceivers().find(t => t.receiver.track.kind === 'video');
  if (!transceiver && create) transceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
  if (transceiver) transceiver.direction = 'sendrecv';
  return transceiver?.sender;
}

export function createCallExtras(cur, { active, update, signal, notice, media = navigator.mediaDevices }) {
  let disposed = false, busy = false, polling = false, timer, voiceBusy = false;
  let screen = null, previousTrack = null, statsPrevious = new Map(), badSamples = 0, goodSamples = 0;
  let constrained = false;
  const alive = () => !disposed && active();
  const sender = () => cur.pc.getTransceivers().find(t => t.receiver.track.kind === 'video' &&
    ['sendrecv', 'sendonly'].includes(t.currentDirection))?.sender;
  const stopTracks = stream => stream?.getTracks().forEach(t => { t.onended = null; t.stop(); });
  const publish = () => {
    if (!alive()) return;
    const video = cur.pc.getSenders().find(s => s.track?.kind === 'video')?.track;
    signal({ t: 'media', screen: !!screen, video: !!video && video.enabled && video.readyState === 'live' }).catch(() => {});
  };
  async function tune() {
    for (const s of cur.pc.getSenders()) {
      if (!s.track || !alive()) continue;
      try {
        const p = s.getParameters();
        if (!p.encodings?.length) continue;
        const video = s.track.kind === 'video';
        p.encodings[0].maxBitrate = video ? (constrained ? 650000 : screen ? 1800000 : 2500000) : 48000;
        if (video) {
          p.encodings[0].maxFramerate = constrained ? 10 : screen ? 15 : 30;
          p.degradationPreference = screen ? 'maintain-resolution' : 'balanced';
          s.track.contentHint = screen ? 'detail' : 'motion';
        }
        await s.setParameters(p);
      } catch { /* Browser may not support all parameters; keep the working stream. */ }
    }
  }
  async function stopScreen() {
    if (!screen || busy || !alive()) return;
    busy = true;
    const stream = screen;
    const restore = previousTrack?.readyState === 'live' ? previousTrack : null;
    try {
      await sender()?.replaceTrack(restore);
      if (!alive()) return;
      screen = null; previousTrack = null;
      cur.sharingScreen = false;
      cur.screenPreview = null;
      await tune();
    } catch {
      // Always stop capture even if restoring the camera fails.
      screen = null; previousTrack = null;
      cur.sharingScreen = false; cur.screenPreview = null;
      notice('Показ остановлен. Не удалось вернуть камеру.');
    } finally {
      stopTracks(stream); busy = false;
      if (alive()) { publish(); update(); }
    }
  }
  async function startScreen() {
    if (!alive() || busy || screen) return;
    if (!media?.getDisplayMedia) return notice('Этот браузер не поддерживает передачу экрана.');
    const output = sender();
    if (!output) return notice('Для показа экрана начните новый звонок: звонящий должен открыть тестовую ссылку.');
    busy = true;
    let stream;
    try {
      // Called directly from a click; browser consent must never be bypassed.
      stream = await media.getDisplayMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15, max: 15 } }, audio: false });
      if (!alive()) { stopTracks(stream); return; }
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') { stopTracks(stream); return; }
      previousTrack = output.track;
      await output.replaceTrack(track);
      if (!alive()) { stopTracks(stream); return; }
      screen = stream; cur.sharingScreen = true; cur.screenPreview = stream;
      track.onended = () => stopScreen();
      await tune();
      publish(); update();
    } catch (e) {
      stopTracks(stream);
      if (alive() && e.name !== 'NotAllowedError' && e.name !== 'AbortError') notice('Не удалось запустить демонстрацию экрана.');
    } finally {
      busy = false;
      if (screen?.getVideoTracks()[0]?.readyState === 'ended') stopScreen();
    }
  }
  async function toggleVoice() {
    if (!alive() || voiceBusy) return;
    const track = cur.local?.getAudioTracks()[0];
    if (!track) return;
    voiceBusy = true;
    const natural = !cur.naturalVoice;
    try {
      await track.applyConstraints({ echoCancellation: true, noiseSuppression: !natural, autoGainControl: !natural, channelCount: { ideal: 1 } });
      if (alive()) { cur.naturalVoice = natural; update(); }
    } catch { if (alive()) notice('Браузер не смог изменить обработку микрофона.'); }
    finally { voiceBusy = false; }
  }
  async function poll() {
    if (!alive() || polling) return;
    polling = true;
    try {
      const stats = await cur.pc.getStats();
      if (!alive()) return;
      let loss = 0, rtt = 0, jitter = 0, measured = false, outgoing = false;
      const next = new Map();
      stats.forEach(s => {
        if ((s.kind || s.mediaType) !== 'audio') return;
        if (s.type === 'inbound-rtp') {
          const prev = statsPrevious.get(s.id);
          next.set(s.id, { lost: s.packetsLost || 0, received: s.packetsReceived || 0 });
          if (prev) {
            const lost = Math.max(0, (s.packetsLost || 0) - prev.lost);
            const received = Math.max(0, (s.packetsReceived || 0) - prev.received);
            if (lost + received) { measured = true; loss = Math.max(loss, lost / (lost + received)); }
          }
          jitter = Math.max(jitter, s.jitter || 0);
        }
        if (s.type === 'remote-inbound-rtp') {
          if (Number.isFinite(s.roundTripTime)) { rtt = Math.max(rtt, s.roundTripTime); measured = true; outgoing = true; }
          if (Number.isFinite(s.fractionLost)) { loss = Math.max(loss, s.fractionLost); measured = true; outgoing = true; }
        }
      });
      statsPrevious = next;
      const bad = loss > .05 || rtt > .6 || jitter > .08;
      cur.callQuality = !measured ? 'Проверка связи…' : bad ? 'Слабая связь' : 'Связь стабильна';
      if (outgoing) {
        badSamples = bad ? badSamples + 1 : 0;
        goodSamples = bad ? 0 : goodSamples + 1;
        const before = constrained;
        if (badSamples >= 2) constrained = true;
        if (goodSamples >= 4) constrained = false;
        if (before !== constrained) await tune();
      }
      publish(); update();
    } catch { /* Stats must never interrupt the call. */ }
    finally { polling = false; }
  }
  return {
    startScreen, stopScreen, toggleVoice, tune, poll, publish,
    start() { if (!timer && alive()) { tune(); timer = setInterval(poll, 3000); poll(); } },
    dispose() { disposed = true; clearInterval(timer); stopTracks(screen); screen = null; cur.screenPreview = null; },
  };
}
