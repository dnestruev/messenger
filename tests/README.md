# Проверки (для Claude)

Ничего из этой папки сайту не нужно — это стенд для проверки перед выкладкой.

**База** (`tests/db`): локальный PostgreSQL 16 с заглушками Supabase.
```
mkdir -p /tmp/pgdata && chown postgres /tmp/pgdata
su postgres -s /bin/sh -c "/usr/lib/postgresql/16/bin/initdb -D /tmp/pgdata -U postgres --auth=trust"
su postgres -s /bin/sh -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgdata -o '-p 5544 -k /tmp' -l /tmp/pgdata/log.txt start"
sh tests/db/run.sh            # schema + все update-*.sql
psql -h /tmp -p 5544 -U postgres -d t -f tests/db/t12.sql   # сценарии под ролью authenticated (t13.sql — отчёты о звонках)
```

**Приложение** (`tests/app`): `server.mjs` — Supabase в памяти (таблицы, rpc, хранилище, realtime через опрос),
`mock.js` — подмена supabase-js. Playwright (Python) + `/usr/bin/google-chrome`.
```
sh tests/app/build.sh                                   # копия сайта в /home/claude/test/site
node tests/app/server.mjs /home/claude/test/site 8765 &
python3 tests/app/t_basic.py   # чаты, ответы, правка, реакции, фото, группы, удаление
python3 tests/app/t_calls.py   # звонки (в т.ч. 2 устройства), голосовые
python3 tests/app/t_calls2.py  # звонки: адреса только из SDP, поздний ответ, перевход, «печатает»
python3 tests/app/t_more.py    # добавление в группу, подписи к фото, правка + стикер, счётчик
python3 tests/app/t_window.py  # окно из 80 сообщений, «Показать более ранние», цитата/поиск за окном
python3 tests/app/t_calls3.py  # звонок с TURN от сервера (одинаковые адреса у разных логинов)
python3 tests/app/t_send.py      # отправка без ожидания сервера
python3 tests/app/t_pins_news.py # закреплённые чаты и новости
python3 tests/app/t_admin.py     # админка, бан, смена ника
python3 tests/app/t_partner.py # уровни партнёров, TURN партнёра, донаты, значки
python3 tests/app/t_layout.py  # скриншоты 320×568, 375×667, 667×375, 1440×900 → /home/claude/test/shots
```
Заглушка не проверяет правила доступа (RLS) — их проверяют SQL-сценарии в `tests/db`.
