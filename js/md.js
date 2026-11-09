// Markdown для сообщений. Только безопасные DOM-узлы, никакого innerHTML.
//   **жирный**  *курсив* или _курсив_  __подчёркнутый__  ~~зачёркнутый~~  ||спойлер||
//   `код`  ```блок кода```  > цитата  - список  1. список  # заголовок
//   [текст](https://…) и просто ссылки https://…

const el = (tag, cls, children = []) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of [].concat(children)) e.append(c);
  return e;
};

const URL_RE = /^https?:\/\/[^\s<]+[^\s<.,:;"'»)\]!?]/;
const isWord = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);

const RULES = [
  { re: /^`([^`\n]+)`/, make: (m) => el('code', 'md-code', m[1]) },
  { re: /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/, make: (m) => link(m[2], inline(m[1])) },
  { re: URL_RE, make: (m) => link(m[0], m[0]) },
  { re: /^\*\*(?=\S)([\s\S]*?\S)\*\*/, make: (m) => el('strong', '', inline(m[1])) },
  { re: /^__(?=\S)([\s\S]*?\S)__/, make: (m) => el('u', '', inline(m[1])) },
  { re: /^~~(?=\S)([\s\S]*?\S)~~/, make: (m) => el('s', '', inline(m[1])) },
  { re: /^\|\|(?=\S)([\s\S]*?\S)\|\|/, make: (m) => spoiler(inline(m[1])) },
  { re: /^\*(?=[^\s*])([^*\n]*?[^\s*])?\*/, make: (m, src) => el('em', '', inline(src.slice(1, m[0].length - 1))) },
  { re: /^_(?=[^\s_])([^_\n]*?[^\s_])?_/, word: true, make: (m, src) => el('em', '', inline(src.slice(1, m[0].length - 1))) },
];

function link(href, children) {
  const a = el('a', 'md-link', children);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer nofollow';
  a.addEventListener('click', (e) => e.stopPropagation());
  return a;
}

function spoiler(children) {
  const s = el('span', 'md-spoiler', children);
  s.title = 'Нажмите, чтобы показать';
  s.addEventListener('click', (e) => {
    if (s.classList.contains('open')) return;
    e.stopPropagation();
    s.classList.add('open');
  });
  return s;
}

/** Строчное форматирование → массив узлов */
export function inline(text) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if ('`[h*_~|'.includes(ch)) {
      const rest = text.slice(i);
      let hit = null;
      for (const r of RULES) {
        if (r.re === URL_RE && ch !== 'h') continue;
        const m = rest.match(r.re);
        if (!m) continue;
        // _курсив_ только на границе слов, чтобы snake_case не ломался
        if (r.word && (isWord(text[i - 1]) || isWord(text[i + m[0].length]))) continue;
        hit = { node: r.make(m, rest), len: m[0].length };
        break;
      }
      if (hit) { flush(); out.push(hit.node); i += hit.len; continue; }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** Сообщение целиком → DocumentFragment */
export function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = el('div', 'md-p');
    para.forEach((line, k) => { if (k) p.append(document.createElement('br')); p.append(...inline(line)); });
    frag.append(p);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ```блок кода```
    if (/^\s*```/.test(line)) {
      const body = [];
      const first = line.replace(/^\s*```[\w-]*/, '');
      if (/```\s*$/.test(first) && first.trim() !== '```' && first.trim()) {      // ```код``` в одну строку
        flushPara();
        frag.append(el('pre', 'md-pre', el('code', '', first.replace(/```\s*$/, ''))));
        continue;
      }
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) body.push(lines[j++]);
      if (j < lines.length) {
        flushPara();
        frag.append(el('pre', 'md-pre', el('code', '', body.join('\n'))));
        i = j;
        continue;
      }
    }

    // > цитата
    if (/^>\s?/.test(line)) {
      flushPara();
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      i--;
      const bq = el('blockquote', 'md-quote');
      q.forEach((l, k) => { if (k) bq.append(document.createElement('br')); bq.append(...inline(l)); });
      frag.append(bq);
      continue;
    }

    // - список / 1. список
    const bullet = /^\s*([-*•])\s+(.+)/, num = /^\s*(\d{1,3})[.)]\s+(.+)/;
    if (bullet.test(line) || num.test(line)) {
      flushPara();
      const ordered = num.test(line);
      const re = ordered ? num : bullet;
      const list = el(ordered ? 'ol' : 'ul', 'md-list');
      if (ordered) list.start = +line.match(num)[1];
      while (i < lines.length && re.test(lines[i])) list.append(el('li', '', inline(lines[i++].match(re)[2])));
      i--;
      frag.append(list);
      continue;
    }

    // # заголовок
    const hd = line.match(/^(#{1,3})\s+(.+)/);
    if (hd) { flushPara(); frag.append(el('div', 'md-h md-h' + hd[1].length, inline(hd[2]))); continue; }

    if (!line.trim()) { flushPara(); continue; }
    para.push(line);
  }
  flushPara();
  return frag;
}

/** Текст без разметки — для превью в списке чатов, уведомлений и цитат */
export function stripMarkdown(src) {
  return String(src)
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/\|\|([\s\S]+?)\|\|/g, '▒▒▒')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*/gu, '$1$2')
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}])/gu, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^#{1,3}\s+/gm, '');
}
