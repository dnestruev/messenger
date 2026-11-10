#!/bin/sh
# Проставить номер версии сайта перед КАЖДОЙ выкладкой.
# Без этого браузеры до 10 минут берут старые файлы из кеша и смешивают старое оформление с новым кодом.
cd "$(dirname "$0")/.." || exit 1
V=$(date -u +%Y%m%d%H%M%S)
printf '{ "v": "%s" }\n' "$V" > version.json
sed -i -E "s#(js/main\.js|css/styles\.css)\?v=[^\"]*#\1?v=$V#g" index.html
sed -i -E "s#from '(\./(crypto|net|qr|md|stickers|embeds)\.js|\.\./config\.js)\?v=[^']*'#from '\1?v=$V'#" js/main.js
sed -i -E "s#from '\./crypto\.js\?v=[^']*'#from './crypto.js?v=$V'#" js/net.js
echo "$V"
