// Плееры для ссылок: Spotify, Яндекс Музыка, YouTube, SoundCloud.
// Плеер грузится только по нажатию — до этого сервисы ничего не знают о переписке.

const RULES = [
  {
    re: /https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{10,40})/,
    make: (m) => ({ service: 'Spotify', kind: { track: 'трек', album: 'альбом', playlist: 'плейлист', episode: 'подкаст', show: 'подкаст', artist: 'артист' }[m[1]],
      src: `https://open.spotify.com/embed/${m[1]}/${m[2]}?utm_source=generator&theme=0`, height: m[1] === 'track' || m[1] === 'episode' ? 152 : 352, color: '#1db954' }),
  },
  {
    re: /https?:\/\/music\.yandex\.(?:ru|com|by|kz|uz)\/album\/(\d+)\/track\/(\d+)/,
    make: (m) => ({ service: 'Яндекс Музыка', kind: 'трек', src: `https://music.yandex.ru/iframe/track/${m[2]}/${m[1]}`, height: 180, color: '#ffcc00' }),
  },
  {
    re: /https?:\/\/music\.yandex\.(?:ru|com|by|kz|uz)\/album\/(\d+)(?![\d/]*track)/,
    make: (m) => ({ service: 'Яндекс Музыка', kind: 'альбом', src: `https://music.yandex.ru/iframe/album/${m[1]}`, height: 450, color: '#ffcc00' }),
  },
  {
    re: /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^ ]*&)?v=|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
    make: (m) => ({ service: 'YouTube', kind: 'видео', src: `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1`, ratio: '16 / 9', color: '#ff0033' }),
  },
  {
    re: /https?:\/\/(?:www\.|m\.)?soundcloud\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/,
    make: (m) => ({ service: 'SoundCloud', kind: 'трек', src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(m[0])}&auto_play=true&visual=false`, height: 166, color: '#ff5500' }),
  },
];

/** Первый поддерживаемый плеер в тексте сообщения или null */
export function findEmbed(text) {
  if (!text) return null;
  for (const r of RULES) {
    const m = String(text).match(r.re);
    if (m) return { url: m[0], ...r.make(m) };
  }
  return null;
}
