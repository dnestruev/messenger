// Свой набор стикеров «Точка» — нарисован кодом (SVG), поэтому почти ничего не весит:
// в сообщении передаётся только название стикера, а картинка рисуется у получателя.

const C = { ink: '#2b2233', white: '#fff', blush: '#ff8fa3', tear: '#5ab8ff', heart: '#ff4d6d', gold: '#ffc83d', fire: '#ff7a1a' };

const EYES = {
  dot: `<circle cx="78" cy="92" r="9" fill="${C.ink}"/><circle cx="122" cy="92" r="9" fill="${C.ink}"/><circle cx="81" cy="88" r="3" fill="#fff"/><circle cx="125" cy="88" r="3" fill="#fff"/>`,
  happy: `<path d="M66 94q12-14 24 0M110 94q12-14 24 0" stroke="${C.ink}" stroke-width="7" fill="none" stroke-linecap="round"/>`,
  closed: `<path d="M66 92q12 10 24 0M110 92q12 10 24 0" stroke="${C.ink}" stroke-width="7" fill="none" stroke-linecap="round"/>`,
  wide: `<circle cx="78" cy="90" r="15" fill="#fff" stroke="${C.ink}" stroke-width="5"/><circle cx="122" cy="90" r="15" fill="#fff" stroke="${C.ink}" stroke-width="5"/><circle cx="78" cy="92" r="6" fill="${C.ink}"/><circle cx="122" cy="92" r="6" fill="${C.ink}"/>`,
  hearts: `<path d="M78 104l-13-12a8 8 0 0 1 13-10 8 8 0 0 1 13 10z" fill="${C.heart}"/><path d="M122 104l-13-12a8 8 0 0 1 13-10 8 8 0 0 1 13 10z" fill="${C.heart}"/>`,
  stars: `<path d="M78 78l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z" fill="${C.gold}" stroke="${C.ink}" stroke-width="2"/><path d="M122 78l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z" fill="${C.gold}" stroke="${C.ink}" stroke-width="2"/>`,
  angry: `<path d="M64 80l26 9M136 80l-26 9" stroke="${C.ink}" stroke-width="7" stroke-linecap="round"/><circle cx="80" cy="98" r="7" fill="${C.ink}"/><circle cx="120" cy="98" r="7" fill="${C.ink}"/>`,
  sad: `<path d="M66 84l22 6M134 84l-22 6" stroke="${C.ink}" stroke-width="6" stroke-linecap="round"/><circle cx="80" cy="98" r="7" fill="${C.ink}"/><circle cx="120" cy="98" r="7" fill="${C.ink}"/>`,
  wink: `<circle cx="78" cy="92" r="9" fill="${C.ink}"/><circle cx="81" cy="88" r="3" fill="#fff"/><path d="M110 94q12-12 24 0" stroke="${C.ink}" stroke-width="7" fill="none" stroke-linecap="round"/>`,
  shades: `<path d="M56 82h88v6l-6 0q-2 20-20 20t-20-16h-4q-2 16-20 16t-20-20l-4 0z" fill="${C.ink}"/><path d="M70 88l10 0M114 88l10 0" stroke="#fff" stroke-width="3" opacity=".5" stroke-linecap="round"/>`,
  spiral: `<path d="M78 92m-10 0a10 10 0 1 0 10-10a6 6 0 1 0 6 6" stroke="${C.ink}" stroke-width="4" fill="none"/><path d="M122 92m-10 0a10 10 0 1 0 10-10a6 6 0 1 0 6 6" stroke="${C.ink}" stroke-width="4" fill="none"/>`,
  look: `<circle cx="78" cy="92" r="12" fill="#fff" stroke="${C.ink}" stroke-width="4"/><circle cx="122" cy="92" r="12" fill="#fff" stroke="${C.ink}" stroke-width="4"/><circle cx="72" cy="88" r="5" fill="${C.ink}"/><circle cx="116" cy="88" r="5" fill="${C.ink}"/>`,
};

const MOUTH = {
  smile: `<path d="M82 120q18 18 36 0" stroke="${C.ink}" stroke-width="7" fill="none" stroke-linecap="round"/>`,
  grin: `<path d="M76 116q24 4 48 0q-4 26-24 26t-24-26z" fill="${C.ink}"/><path d="M86 132q14 8 28 0q-4 10-14 10t-14-10z" fill="${C.heart}"/>`,
  open: `<ellipse cx="100" cy="128" rx="13" ry="16" fill="${C.ink}"/><ellipse cx="100" cy="135" rx="8" ry="6" fill="${C.heart}"/>`,
  o: `<ellipse cx="100" cy="130" rx="8" ry="10" fill="${C.ink}"/>`,
  sad: `<path d="M82 136q18-16 36 0" stroke="${C.ink}" stroke-width="7" fill="none" stroke-linecap="round"/>`,
  flat: `<path d="M84 128h32" stroke="${C.ink}" stroke-width="7" stroke-linecap="round"/>`,
  tongue: `<path d="M80 118q20 14 40 0" stroke="${C.ink}" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M104 124q12 2 12 12a8 8 0 0 1-16 0v-10z" fill="${C.heart}" stroke="${C.ink}" stroke-width="3"/>`,
  wavy: `<path d="M80 128q5-7 10 0t10 0t10 0t10 0" stroke="${C.ink}" stroke-width="6" fill="none" stroke-linecap="round"/>`,
  kiss: `<path d="M96 118q10 4 0 10q10 4 0 10" stroke="${C.ink}" stroke-width="6" fill="none" stroke-linecap="round"/>`,
  shout: `<path d="M78 118h44l-6 26h-32z" fill="${C.ink}"/><path d="M84 136h32l-2 8h-28z" fill="${C.heart}"/>`,
  smirk: `<path d="M86 126q14 8 30-6" stroke="${C.ink}" stroke-width="7" fill="none" stroke-linecap="round"/>`,
};

const EXTRA = {
  blush: `<ellipse cx="62" cy="114" rx="11" ry="7" fill="${C.blush}" opacity=".75"/><ellipse cx="138" cy="114" rx="11" ry="7" fill="${C.blush}" opacity=".75"/>`,
  tears: `<path d="M64 102q-6 14-2 30q6 8 12 0q2-14-10-30z" fill="${C.tear}"/><path d="M136 102q6 14 2 30q-6 8-12 0q-2-14 10-30z" fill="${C.tear}"/>`,
  laughTears: `<path d="M56 96q-14 6-18 20q6 6 14 0q4-10 4-20z" fill="${C.tear}"/><path d="M144 96q14 6 18 20q-6 6-14 0q-4-10-4-20z" fill="${C.tear}"/>`,
  sweat: `<path d="M146 56q-8 12-6 20q4 6 10 2q4-8-4-22z" fill="${C.tear}"/>`,
  heart: `<path d="M160 52l-16-15a10 10 0 0 1 16-12 10 10 0 0 1 16 12z" fill="${C.heart}"/>`,
  zzz: `<text x="138" y="52" font-family="Arial,sans-serif" font-weight="900" font-size="26" fill="${C.ink}">z</text><text x="156" y="36" font-family="Arial,sans-serif" font-weight="900" font-size="18" fill="${C.ink}">z</text>`,
  question: `<text x="146" y="62" font-family="Arial,sans-serif" font-weight="900" font-size="46" fill="${C.ink}">?</text>`,
  bang: `<text x="150" y="62" font-family="Arial,sans-serif" font-weight="900" font-size="46" fill="${C.heart}">!</text>`,
  fire: `<g transform="translate(100 44) scale(1.9) translate(-100 -44)"><path d="M100 8q26 22 14 44q14-4 10-20q22 24 4 46h-56q-18-22 6-44q-2 14 10 18q-10-24 12-44z" fill="${C.fire}"/><path d="M100 40q12 12 4 26h-12q-6-12 8-26z" fill="${C.gold}"/></g>`,
  sparkles: `<path d="M34 50l4 10 10 4-10 4-4 10-4-10-10-4 10-4z" fill="${C.gold}"/><path d="M166 40l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="${C.gold}"/><path d="M168 150l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="${C.gold}"/>`,
  wave: `<g transform="rotate(-20 168 120)"><rect x="156" y="96" width="22" height="34" rx="11" fill="var(--b)" stroke="${C.ink}" stroke-width="5"/></g><path d="M178 84q8 4 10 12M186 74q10 6 12 18" stroke="${C.ink}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
  thumb: `<g transform="translate(140 104)"><rect x="0" y="16" width="38" height="32" rx="8" fill="var(--b)" stroke="${C.ink}" stroke-width="5"/><path d="M8 16v-14a8 8 0 0 1 16 0v14" fill="var(--b)" stroke="${C.ink}" stroke-width="5"/></g>`,
  steam: `<path d="M40 60q-8-10 0-20M30 70q-10-8-6-20M160 60q8-10 0-20M170 70q10-8 6-20" stroke="#bbb" stroke-width="5" fill="none" stroke-linecap="round"/>`,
  party: `<path d="M64 46l36-40 36 40z" fill="${C.gold}" stroke="${C.ink}" stroke-width="4" stroke-linejoin="round"/><circle cx="100" cy="6" r="7" fill="${C.heart}"/><path d="M78 30l12-4M110 26l12 4M92 40l16 0" stroke="${C.heart}" stroke-width="4" stroke-linecap="round"/>`,
  coffee: `<g transform="translate(138 118)"><path d="M0 0h34v26a12 12 0 0 1-12 12h-10a12 12 0 0 1-12-12z" fill="#fff" stroke="${C.ink}" stroke-width="4"/><path d="M34 6q12 0 10 12t-10 8" stroke="${C.ink}" stroke-width="4" fill="none"/><path d="M10-8q-4-6 0-12M22-8q-4-6 0-12" stroke="#bbb" stroke-width="3" fill="none" stroke-linecap="round"/></g>`,
  phone: `<rect x="148" y="96" width="26" height="44" rx="6" fill="${C.ink}"/><rect x="152" y="102" width="18" height="30" rx="2" fill="#7fd1ff"/>`,
};

// [id, подпись, цвет тела, глаза, рот, украшения…]
export const STICKERS = [
  ['hi', 'Привет', '#ffd84d', 'happy', 'grin', 'wave', 'blush'],
  ['lol', 'Ору', '#ffd84d', 'closed', 'open', 'laughTears'],
  ['love', 'Люблю', '#ff9ec0', 'hearts', 'smile', 'blush', 'heart'],
  ['cool', 'Круто', '#7ad8ff', 'shades', 'smirk'],
  ['ok', 'Ок', '#9fe37a', 'wink', 'smile', 'thumb'],
  ['wow', 'Вау', '#c79bff', 'wide', 'o', 'sparkles'],
  ['sad', 'Грустно', '#9db8ff', 'sad', 'sad', 'tears'],
  ['angry', 'Злой', '#ff7b6b', 'angry', 'shout', 'steam'],
  ['shock', 'Шок', '#ffe7a3', 'wide', 'shout', 'bang'],
  ['hmm', 'Хм', '#ffcf9e', 'look', 'flat', 'question'],
  ['sleep', 'Сплю', '#b8c6ff', 'closed', 'o', 'zzz'],
  ['shy', 'Стесняюсь', '#ffb8c9', 'closed', 'wavy', 'blush', 'sweat'],
  ['fire', 'Огонь', '#ffb03b', 'stars', 'grin', 'fire'],
  ['party', 'Ура', '#ffd84d', 'happy', 'grin', 'party', 'sparkles'],
  ['kiss', 'Чмок', '#ff9ec0', 'closed', 'kiss', 'blush', 'heart'],
  ['tongue', 'Бе', '#9fe37a', 'wink', 'tongue'],
  ['dizzy', 'Голова кругом', '#d0b3ff', 'spiral', 'wavy'],
  ['oops', 'Упс', '#ffe08a', 'wide', 'wavy', 'sweat'],
  ['coffee', 'Кофе', '#d9a77a', 'closed', 'smile', 'coffee'],
  ['brb', 'Сейчас', '#a8e6cf', 'dot', 'smile', 'phone'],
  ['thanks', 'Спасибо', '#ffd84d', 'happy', 'smile', 'blush', 'heart'],
  ['bye', 'Пока', '#7ad8ff', 'happy', 'smile', 'wave'],
  ['cry', 'Плачу', '#9db8ff', 'closed', 'shout', 'tears'],
  ['yes', 'Да!', '#9fe37a', 'stars', 'open', 'sparkles'],
];
const BY_ID = new Map(STICKERS.map((s) => [s[0], s]));
export const stickerLabel = (id) => BY_ID.get(id)?.[1] || 'Стикер';
export const hasSticker = (id) => BY_ID.has(id);

/** SVG стикера (строка). Только наши заранее нарисованные части — безопасно вставлять. */
let uid = 0;   // у каждой картинки свой id градиента: одинаковые id на странице ломают отрисовку в скрытых панелях
export function stickerSvg(id, size = 140) {
  const s = BY_ID.get(id);
  if (!s) return '';
  const g = `g-${id}-${++uid}`;
  const [, , body, eyes, mouth, ...extra] = s;
  const front = extra.filter((e) => e !== 'fire' && e !== 'party');
  const back = extra.filter((e) => e === 'fire' || e === 'party');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="${size}" height="${size}" style="--b:${body}">
<defs><radialGradient id="${g}" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
${back.map((e) => EXTRA[e]).join('')}
<ellipse cx="100" cy="182" rx="52" ry="8" fill="#000" opacity=".12"/>
<circle cx="100" cy="106" r="72" fill="${body}" stroke="${C.ink}" stroke-width="6"/>
<circle cx="100" cy="106" r="69" fill="url(#${g})"/>
${EYES[eyes] || ''}${MOUTH[mouth] || ''}${front.map((e) => EXTRA[e]).join('')}
</svg>`;
}
