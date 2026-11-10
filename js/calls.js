/* Звонки 3: ICE-конфигурация и диагностика сети.
 * Секреты TURN нельзя помещать в публичные файлы GitHub Pages.
 * Временные данные выдаёт авторизованная Supabase Edge Function turn-credentials.
 */
export const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];
const TURN_RE = /^turns?:/i;
let cached = null;
let pending = null;
let pendingUserId = null;

export function hasTurn(servers) {
  return (servers || []).some((server) =>
    (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => TURN_RE.test(url || '')));
}

function usableServers(servers) {
  if (!Array.isArray(servers)) return [];
  return servers.filter((s) => {
    const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
    if (!urls.some((u) => typeof u === 'string' && /^(stun:|stuns:|turn:|turns:)/i.test(u))) return false;
    return !urls.some((u) => TURN_RE.test(u || '')) ||
      (typeof s.username === 'string' && typeof s.credential === 'string' && !!s.credential);
  }).map((s) => ({
    urls: s.urls,
    ...(s.username ? { username: s.username } : {}),
    ...(s.credential ? { credential: s.credential } : {}),
  }));
}

export async function loadIceConfiguration(sb, configuredServers = DEFAULT_ICE_SERVERS, userId = '') {
  // TURN credentials относятся к конкретной учётной записи: не переиспользуем
  // их после выхода из аккаунта и входа под другим пользователем.
  if (cached && cached.userId === userId && cached.until > Date.now()) return cached.value;
  if (pending && pendingUserId === userId) return pending;

  pendingUserId = userId;
  const request = (async () => {
    const fallback = usableServers(configuredServers);
    const defaults = fallback.length ? fallback : DEFAULT_ICE_SERVERS;
    let value = { iceServers: defaults, turnConfigured: hasTurn(defaults), turnError: null };
    let cacheMs = 45_000;
    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Превышено время ожидания TURN')), 3500));
      const result = await Promise.race([sb.functions.invoke('turn-credentials'), timeout]);
      if (result.error) throw result.error;
      const servers = usableServers(result.data?.iceServers);
      if (!hasTurn(servers)) throw new Error('TURN не настроен на сервере');
      // Добавляем STUN: прямое соединение остаётся предпочтительным, TURN служит резервом.
      const withStun = [...DEFAULT_ICE_SERVERS, ...servers];
      value = { iceServers: withStun, turnConfigured: true, turnError: null };
      const ttl = Number(result.data?.ttlSeconds);
      cacheMs = Number.isFinite(ttl) ? Math.min(600_000, Math.max(30_000, ttl * 1000 - 120_000)) : 300_000;
    } catch (error) {
      cacheMs = 120_000;   // TURN не настроен или сеть моргнула — не дёргаем функцию на каждый звонок
      value = {
        iceServers: defaults,
        turnConfigured: hasTurn(defaults),
        turnError: (error?.message || String(error)).slice(0, 150),
      };
    }
    cached = { value, userId, until: Date.now() + cacheMs };
    return value;
  })();
  pending = request.finally(() => {
    if (pendingUserId === userId) {
      pending = null;
      pendingUserId = null;
    }
  });
  return pending;
}

export function candidateType(candidate) {
  const text = typeof candidate === 'string' ? candidate : candidate?.candidate || '';
  return candidate?.type || (/\btyp\s+(host|srflx|prflx|relay)\b/i.exec(text)?.[1] || 'unknown');
}

export function candidateCounts(candidates = []) {
  const counts = { host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 };
  for (const candidate of candidates) {
    const type = candidateType(candidate);
    counts[type in counts ? type : 'unknown']++;
  }
  return counts;
}

export function describeCandidates(candidates) {
  const counts = candidateCounts(candidates);
  return ['host', 'srflx', 'prflx', 'relay'].map((type) => type + ':' + counts[type]).join(', ') +
    (counts.unknown ? ', ?: ' + counts.unknown : '');
}

/** Статистика маршрута без IP-адресов и других личных данных. */
export async function selectedRoute(pc) {
  try {
    const report = await pc.getStats();
    let pair = null;
    for (const entry of report.values()) {
      if (entry.type === 'transport' && entry.selectedCandidatePairId) {
        pair = report.get(entry.selectedCandidatePairId);
        break;
      }
    }
    if (!pair) for (const entry of report.values()) {
      if (entry.type === 'candidate-pair' && (entry.selected || (entry.nominated && entry.state === 'succeeded'))) {
        pair = entry;
        break;
      }
    }
    if (!pair) return 'не выбран';
    const local = report.get(pair.localCandidateId);
    const remote = report.get(pair.remoteCandidateId);
    const left = local ? local.candidateType + '/' + (local.protocol || '?') : '?';
    const right = remote ? remote.candidateType + '/' + (remote.protocol || '?') : '?';
    const rtt = Number.isFinite(pair.currentRoundTripTime) ? ', RTT ' + Math.round(pair.currentRoundTripTime * 1000) + ' мс' : '';
    return left + ' → ' + right + rtt;
  } catch {
    return 'недоступно';
  }
}
