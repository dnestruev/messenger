// Текст из любого файла: Word (.docx/.doc), OpenOffice (.odt), RTF, PDF, HTML, обычный текст (UTF-8 или Windows-1251).
// Всё разбирается прямо в браузере, файл никуда не отправляется.

const dec = (bytes, enc = 'utf-8') => new TextDecoder(enc).decode(bytes);

/** Распаковать один файл из zip (docx и odt — это zip) */
async function zipEntry(buf, wanted) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  let off = dv.getUint32(eocd + 16, true);
  const count = dv.getUint16(eocd + 10, true);
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true), xlen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true), loc = dv.getUint32(off + 42, true);
    const name = dec(buf.subarray(off + 46, off + 46 + nlen));
    off += 46 + nlen + xlen + clen;
    if (name !== wanted) continue;
    const start = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true);
    const data = buf.subarray(start, start + csize);
    if (method === 0) return data;
    if (typeof DecompressionStream === 'undefined') throw new Error('Этот браузер не умеет открывать такие файлы — открой с компьютера или вставь текст');
    return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  }
  return null;
}
const xmlDoc = (bytes) => new DOMParser().parseFromString(dec(bytes), 'application/xml');

function docxParas(xml) {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  return [...xml.getElementsByTagNameNS(W, 'p')].map((p) => {
    let t = '';
    for (const el of p.getElementsByTagNameNS(W, '*')) {
      if (el.localName === 't') t += el.textContent;
      else if (el.localName === 'tab') t += '    ';
      else if (el.localName === 'br' || el.localName === 'cr') t += '\n';
    }
    return t;
  }).join('\n');
}
function odtParas(xml) {
  const T = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
  const walk = (node) => {
    let t = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) t += c.data;
      else if (c.namespaceURI === T && c.localName === 's') t += ' '.repeat(+c.getAttributeNS(T, 'c') || 1);
      else if (c.namespaceURI === T && c.localName === 'tab') t += '    ';
      else if (c.namespaceURI === T && c.localName === 'line-break') t += '\n';
      else if (c.nodeType === 1) t += walk(c);
    }
    return t;
  };
  return [...xml.getElementsByTagNameNS(T, '*')].filter((e) => e.localName === 'p' || e.localName === 'h').map(walk).join('\n');
}

/** RTF: убираем служебные группы, разбираем \par, \'hh, \uN */
function rtfText(src) {
  const cp = (src.match(/\\ansicpg(\d+)/) || [])[1] || '1251';
  let enc = 'windows-' + cp;
  try { new TextDecoder(enc); } catch { enc = 'windows-1251'; }
  const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'mmathPr', 'pgdsctbl', 'filetbl', 'revtbl']);
  const out = [], stack = [];
  let skip = false, uc = 1, pendingSkip = 0, bytes = [];
  const flush = () => { if (bytes.length) { out.push(new TextDecoder(enc).decode(new Uint8Array(bytes))); bytes = []; } };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { stack.push({ skip, uc }); continue; }
    if (ch === '}') { flush(); const s = stack.pop(); if (s) { skip = s.skip; uc = s.uc; } continue; }
    if (ch === '\\') {
      const nx = src[i + 1];
      if (nx === '\'') {
        const b = parseInt(src.substr(i + 2, 2), 16); i += 3;
        if (pendingSkip > 0) { pendingSkip--; continue; }
        if (!skip && !Number.isNaN(b)) bytes.push(b);
        continue;
      }
      if (nx === '*') { skip = true; i++; continue; }
      if (nx === '\\' || nx === '{' || nx === '}') { if (!skip) { flush(); out.push(nx); } i++; continue; }
      if (nx === '~') { if (!skip) { flush(); out.push(' '); } i++; continue; }
      if (nx === '\n' || nx === '\r') { if (!skip) { flush(); out.push('\n'); } i++; continue; }
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i + 1, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      const word = m[1], arg = m[2] != null ? +m[2] : null;
      if (SKIP.has(word)) { skip = true; continue; }
      if (skip) continue;
      if (word === 'par' || word === 'line' || word === 'sect' || word === 'row') { flush(); out.push('\n'); }
      else if (word === 'tab') { flush(); out.push('    '); }
      else if (word === 'cell') { flush(); out.push(' '); }
      else if (word === 'uc') uc = arg ?? 1;
      else if (word === 'u') { flush(); out.push(String.fromCharCode(arg < 0 ? arg + 65536 : arg)); pendingSkip = uc; }
      continue;
    }
    if (ch === '\r' || ch === '\n') continue;
    if (skip) continue;
    if (pendingSkip > 0) { pendingSkip--; continue; }
    const code = ch.charCodeAt(0);
    if (code < 128) { flush(); out.push(ch); } else bytes.push(code & 255);
  }
  flush();
  return out.join('');
}

/** Старый Word (.doc): текст лежит в файле как UTF-16 — вынимаем «похожие на текст» куски */
function docText(buf) {
  const parts = [];
  let cur = '';
  const ok = (c) => c === 9 || c === 13 || c === 11 || (c >= 32 && c < 127) || (c >= 0x400 && c <= 0x4ff) || c === 0xab || c === 0xbb || (c >= 0x2010 && c <= 0x2026) || c === 0xa0 || c === 0x2116;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const c = buf[i] | (buf[i + 1] << 8);
    if (ok(c)) cur += c === 13 || c === 11 ? '\n' : c === 9 ? '    ' : String.fromCharCode(c);
    else { if (cur.replace(/\s/g, '').length >= 4) parts.push(cur); cur = ''; }
  }
  if (cur.replace(/\s/g, '').length >= 4) parts.push(cur);
  // самый длинный кусок с переводами строк — обычно и есть документ
  const main = parts.filter((p) => p.includes('\n')).sort((a, b) => b.length - a.length)[0];
  return main || parts.join('\n');
}

function htmlText(src) {
  const doc = new DOMParser().parseFromString(src, 'text/html');
  const BLOCK = /^(P|DIV|LI|TR|H[1-6]|PRE|BR|TABLE|UL|OL|SECTION|ARTICLE|BLOCKQUOTE)$/;
  let t = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) t += c.data.replace(/\s+/g, c.parentNode.closest?.('pre') ? '$&' : ' ');
      else if (c.nodeType === 1 && !/^(SCRIPT|STYLE|HEAD)$/.test(c.tagName)) {
        if (c.tagName === 'BR') { t += '\n'; continue; }
        walk(c);
        if (BLOCK.test(c.tagName)) t += '\n';
      }
    }
  };
  walk(doc.body || doc);
  return t;
}

async function pdfText(buf) {
  const pdfjs = await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  const pdf = await pdfjs.getDocument({ data: buf, isEvalSupported: false }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const { items } = await page.getTextContent();
    let line = '', lastY = null;
    for (const it of items) {
      const y = Math.round(it.transform?.[5] ?? 0);
      if (lastY != null && Math.abs(y - lastY) > 2 && line) { lines.push(line); line = ''; }
      line += it.str;
      lastY = y;
      if (it.hasEOL) { lines.push(line); line = ''; lastY = null; }
    }
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

function plainText(buf) {
  let t = dec(buf);
  if ((t.match(/�/g) || []).length > 3) t = dec(buf, 'windows-1251');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t;
}

/** Главная: текст любого файла (или понятная ошибка) */
export async function fileText(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const name = (file.name || '').toLowerCase(), head = dec(buf.subarray(0, 8), 'latin1');
  if (/^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|heic|bmp)$/.test(name)) throw new Error('Картинку прочитать не получится — пришли тест файлом (Word, PDF, текст) или вставь текст');
  if (head.startsWith('%PDF')) return pdfText(buf);
  if (head.startsWith('PK')) {
    const w = await zipEntry(buf, 'word/document.xml');
    if (w) return docxParas(xmlDoc(w));
    const o = await zipEntry(buf, 'content.xml');
    if (o) return odtParas(xmlDoc(o));
    throw new Error('Не понял этот архив — пришли Word, PDF или текст');
  }
  if (head.startsWith('{\\rtf')) return rtfText(dec(buf, 'latin1'));
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return docText(buf);   // старый .doc
  const t = plainText(buf);
  if (/^\s*</.test(t) && /<(html|body|p|div)[\s>]/i.test(t)) return htmlText(t);
  return t;
}
