// Сеть партнёров. Узлы хранят зашифрованные куски; имя куска = <id чата>/<sha-256 содержимого>.
// Всё, что приходит с узла, проверяется по хешу: подмену видно сразу, а на узел уходит жалоба.
import { b64, sha256hex } from './crypto.js?v=20261111185209';

const COPIES = 2;            // сколько копий держим в сети
const TIMEOUT = 7000;        // сколько ждём узел, мс
const RELOAD_EVERY = 60000;  // как часто обновляем список узлов

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
async function fetchWithTimeout(url, options = {}, ms = TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

export function createNet(sb) {
  const nodes = new Map();      // id -> { id, url, status, owner }
  const sleepy = new Map();     // узел -> когда не ответил; минуту его не спрашиваем, если есть другие
  const SLEEP_MS = 60000;
  const isSleepy = (id) => sleepy.has(id) && Date.now() - sleepy.get(id) < SLEEP_MS;
  const nap = (id) => sleepy.set(id, Date.now());
  const reported = new Set();
  let loadedAt = 0;

  async function load(force = false) {
    if (!force && nodes.size && Date.now() - loadedAt < RELOAD_EVERY) return;
    const { data, error } = await sb.from('nodes').select('id, url, status, owner');
    if (error) return;
    nodes.clear();
    for (const n of data || []) nodes.set(n.id, n);
    loadedAt = Date.now();
  }
  const active = () => [...nodes.values()].filter((n) => n.status === 'active');
  const ordered = (list) => [...shuffle(list.filter((n) => !isSleepy(n.id))), ...list.filter((n) => isSleepy(n.id))];

  /** Копии — на узлах РАЗНЫХ владельцев: если один партнёр уйдёт, вторая копия останется.
      Владельцы выбираются поровну, сколько бы узлов у каждого ни было. */
  function spread(list) {
    const byOwner = new Map();
    for (const n of list) {
      const k = n.owner || n.id;
      if (!byOwner.has(k)) byOwner.set(k, []);
      byOwner.get(k).push(n);
    }
    const groups = shuffle([...byOwner.values()]);
    const out = [];
    for (let round = 0; out.length < list.length; round++) {
      for (const g of groups) if (g[round]) out.push(g[round]);
    }
    return out;
  }

  async function token() {
    const { data } = await sb.auth.getSession();
    return data.session?.access_token || '';
  }

  function report(nodeId, reason) {
    if (reported.has(nodeId)) return;
    reported.add(nodeId);
    sb.rpc('report_node', { p_node: nodeId, p_reason: reason }).then(() => {}, () => {});
  }

  async function putOne(node, key, data, auth) {
    try {
      const r = await fetchWithTimeout(`${node.url}/functions/v1/node?op=put`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, data }),
      }, 15000);
      if (r.ok) return true;
      if (r.status >= 500) nap(node.id);
      return false;
    } catch { nap(node.id); return false; }
  }

  /** Положить кусок на COPIES узлов. Возвращает id узлов, где он сохранился (может быть пусто). */
  async function put(key, bytes) {
    await load();
    const all = active();
    const list = [...spread(all.filter((n) => !isSleepy(n.id))), ...spread(all.filter((n) => isSleepy(n.id)))];
    if (!list.length) return [];
    const auth = await token();
    const data = b64.enc(bytes);
    const ok = [];
    let i = 0;
    while (ok.length < COPIES && i < list.length) {
      const batch = list.slice(i, i + (COPIES - ok.length));
      i += batch.length;
      const res = await Promise.all(batch.map((n) => putOne(n, key, data, auth)));
      res.forEach((good, k) => { if (good) ok.push(batch[k].id); });
    }
    return ok;
  }

  /** Достать кусок с любого из узлов и проверить хеш. null — ни один узел не отдал правильные данные. */
  async function get(nodeIds, key, hash) {
    await load();
    const all = ordered((nodeIds || []).map((id) => nodes.get(id)).filter(Boolean));
    // Сначала быстрые, затем временно недоступные: последняя копия может быть у них.
    const list = all;
    for (const node of list) {
      try {
        const r = await fetchWithTimeout(`${node.url}/storage/v1/object/public/blobs/${key}`);
        if (!r.ok) {
          if (r.status === 400 || r.status === 404) report(node.id, 'нет данных');
          else nap(node.id);
          continue;
        }
        const bytes = new Uint8Array(await r.arrayBuffer());
        if ((await sha256hex(bytes)) !== hash) { report(node.id, 'подменённые данные'); continue; }
        sleepy.delete(node.id);
        return bytes;
      } catch { nap(node.id); }
    }
    return null;
  }

  /** Удалить свой кусок со всех узлов (без ожидания результата). */
  async function del(nodeIds, key) {
    await load();
    const auth = await token();
    for (const id of nodeIds || []) {
      const node = nodes.get(id);
      if (!node) continue;
      fetchWithTimeout(`${node.url}/functions/v1/node?op=del`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      }).catch(() => {});
    }
  }

  /** Проверка узла: отвечает ли функция node. */
  async function health(url) {
    try {
      const r = await fetchWithTimeout(`${url}/functions/v1/node?op=health`, {}, 8000);
      const j = await r.json();
      return r.ok && j?.ok === true && j?.node === 'messenger-node';
    } catch { return false; }
  }

  return { load, active, put, get, del, report, health, nodes };
}
