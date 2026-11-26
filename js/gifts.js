// Подарки: свои рисунки (SVG). Никаких чужих логотипов и этикеток — всё нарисовано с нуля.
const WHISKY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 160">
<defs>
  <linearGradient id="glass" x1="0" x2="1"><stop offset="0" stop-color="#6b3a12" stop-opacity=".55"/><stop offset=".45" stop-color="#c9782b" stop-opacity=".35"/><stop offset="1" stop-color="#5a2e0c" stop-opacity=".6"/></linearGradient>
  <linearGradient id="liq" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0a43a"/><stop offset=".55" stop-color="#c06a18"/><stop offset="1" stop-color="#7a3a08"/></linearGradient>
  <linearGradient id="cap" x1="0" x2="1"><stop offset="0" stop-color="#8a5a12"/><stop offset=".35" stop-color="#ffd877"/><stop offset=".7" stop-color="#d9a032"/><stop offset="1" stop-color="#7a4c0c"/></linearGradient>
  <linearGradient id="label" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6e3"/><stop offset="1" stop-color="#f0dcb4"/></linearGradient>
  <radialGradient id="glow" cx=".5" cy=".55" r=".5"><stop offset="0" stop-color="#ffb84d" stop-opacity=".55"/><stop offset="1" stop-color="#ffb84d" stop-opacity="0"/></radialGradient>
  <clipPath id="body"><path d="M50 34v10c0 6-18 12-18 30v62c0 8 5 13 13 13h30c8 0 13-5 13-13V74c0-18-18-24-18-30V34Z"/></clipPath>
</defs>
<ellipse cx="60" cy="152" rx="36" ry="5" fill="#000" opacity=".18"/>
<circle cx="60" cy="96" r="58" fill="url(#glow)"/>
<path d="M50 34v10c0 6-18 12-18 30v62c0 8 5 13 13 13h30c8 0 13-5 13-13V74c0-18-18-24-18-30V34Z" fill="url(#glass)"/>
<g clip-path="url(#body)">
  <path d="M20 78c10-4 18 3 28 0s20-5 30-1 14 2 22-1v80H20Z" fill="url(#liq)"/>
  <path d="M20 78c10-4 18 3 28 0s20-5 30-1 14 2 22-1" fill="none" stroke="#ffd48a" stroke-width="1.5" opacity=".8"/>
  <circle cx="72" cy="128" r="1.6" fill="#ffe3a8" opacity=".7"/><circle cx="66" cy="138" r="1.1" fill="#ffe3a8" opacity=".6"/><circle cx="76" cy="112" r="1.2" fill="#ffe3a8" opacity=".6"/>
</g>
<path d="M50 34v10c0 6-18 12-18 30v62c0 8 5 13 13 13h30c8 0 13-5 13-13V74c0-18-18-24-18-30V34Z" fill="none" stroke="#3b1d06" stroke-opacity=".5" stroke-width="1.5"/>
<rect x="36" y="92" width="48" height="38" rx="5" fill="url(#label)" stroke="#b8893c" stroke-width="1.2"/>
<rect x="39" y="95" width="42" height="32" rx="3" fill="none" stroke="#c9a55e" stroke-width=".8" stroke-dasharray="2 1.5"/>
<path d="M60 99l2.4 4.6 5 .7-3.7 3.4.9 5-4.6-2.4-4.6 2.4.9-5-3.7-3.4 5-.7Z" fill="#c8892a"/>
<text x="60" y="121" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="9.5" font-weight="700" fill="#4a2508" letter-spacing="1.2">DELTA</text>
<text x="60" y="127" text-anchor="middle" font-family="Georgia, serif" font-size="3.6" fill="#7a4c1c" letter-spacing=".8">SMALL BATCH · №1</text>
<rect x="48" y="12" width="24" height="24" rx="3" fill="url(#cap)"/>
<path d="M51 14v20M55 14v20M59 14v20M63 14v20M67 14v20" stroke="#6b420a" stroke-opacity=".35" stroke-width="1"/>
<rect x="46" y="33" width="28" height="4" rx="2" fill="#a8731c"/>
<path d="M40 76c-3 10-3 40-2 58" stroke="#fff" stroke-opacity=".45" stroke-width="3.5" stroke-linecap="round" fill="none"/>
<path d="M45 70c-1.5 3-2.3 6-2.6 9" stroke="#fff" stroke-opacity=".5" stroke-width="2" stroke-linecap="round" fill="none"/>
</svg>`;

export const GIFT_ART = { whisky: WHISKY };
export const GIFT_INFO = {
  whisky: { name: 'Виски «Дельта»', about: 'Бутылочка нашего фирменного — с золотой крышкой и звездой на этикетке. Пить нельзя, хвастаться можно.' },
};
const cache = new Map();
/** Картинка подарка как data-URL (рисуется браузером один раз) */
export function giftUrl(kind) {
  if (!cache.has(kind)) cache.set(kind, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(GIFT_ART[kind] || GIFT_ART.whisky));
  return cache.get(kind);
}
