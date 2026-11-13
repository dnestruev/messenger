# Лента «События» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** создатель видит в одном месте заявки, новые узлы/TURN, регистрации и баны модераторов.

**Architecture:** таблица `admin_events` заполняется триггерами в базе; клиент создателя читает её, слушает Realtime и показывает строкой «События» с модальным списком.

**Tech Stack:** Postgres (plpgsql, RLS, Realtime), ванильный JS (`js/main.js`), стенд `tests/db`, `tests/app` (Playwright).

**Spec:** `docs/superpowers/specs/2026-11-13-events-feed-design.md`

## Global Constraints
- База меняется только файлом `update-23.sql`; в рабочую — после фразы владельца «применяй update-23».
- Перед выкладкой `./scripts/bump.sh`; коммиты от `dnestruev` с трейлерами.
- Звонки не трогать. Функции, вызываемые через API, — без UPDATE/DELETE без WHERE.
- До применения update-23 клиент не должен ломаться: таблицы нет → строки «События» нет.

## Review Focus
1. Сбой записи события (например, слишком длинный текст) не должен ломать заявку/регистрацию/бан → тест в Task 1 (шаг 1, п. 9).
2. Не-создатель (в т.ч. старший модератор) не читает `admin_events` ни напрямую, ни через Realtime → Task 1 (п. 8).
3. Бан, поставленный самим создателем, в ленту не пишется → Task 1 (п. 6).
4. Ник с markdown/HTML-символами в тексте события выводится как текст → Task 2 (текст через `textContent`, проверка в t_events).
5. Событие, пришедшее при открытом списке, появляется сверху и не увеличивает счётчик → Task 2.

---

### Task 1: база — `update-23.sql`
**Files:** Create `update-23.sql`, `tests/db/t23.sql`; Modify `tests/db/run.sh` только если он перечисляет файлы поимённо.

**Interfaces — Produces:**
- `public.admin_events(id bigint identity pk, kind text, text text, go text, created_at timestamptz default now())`; select — только `is_creator(auth.uid())`; в публикации `supabase_realtime`.
- `public.log_event(p_kind text, p_text text, p_go text default null) returns void` — security definer, тело в `begin … exception when others then null; end`, текст режется `left(…, 300)`; execute отозван у клиентов.
- kinds и go: `order_limited`/`orders`, `order_premium`/`orders`, `resale`/null, `node_new`/`nodes`, `node_down`/`nodes`, `node_up`/`nodes`, `turn_new`/`nodes`, `user_new`/`user:<ник>`, `ban`/`user:<ник>`, `unban`/`user:<ник>`.
- cron `events-cleanup` (ежедневно, удаляет старше 60 дней).

- [ ] Шаг 1: написать `tests/db/t23.sql` с проверками: (1) заявка на лимитку → 1 событие `order_limited`, в тексте ник и сумма; (2) заявка на Премиум → `order_premium`; (3) одобренная сделка с рук → `resale`; (4) `register_node`/вставка узла → `node_new`, смена status active→failing → `node_down`, обратно → `node_up`; (5) новый профиль → `user_new`; (6) бан модератором → `ban`, бан создателем → события нет; разбан модератором → `unban`; (7) создатель читает все; (8) обычный и старший модератор: `select * from admin_events` → 0 строк; (9) при сломанном `log_event` (временно `raise` внутри) заявка всё равно создаётся.
- [ ] Шаг 2: прогнать — упасть должно на «relation admin_events does not exist».
- [ ] Шаг 3: написать `update-23.sql` (таблица, RLS, `log_event`, по одной триггерной функции на источник, публикация, cron). Идемпотентно.
- [ ] Шаг 4: `sh tests/db/run.sh && psql … -f tests/db/t23.sql` — все пункты как ожидается; прогнать t19, t21 — без изменений.
- [ ] Шаг 5: commit.

### Task 2: клиент — строка, список, переходы
**Files:** Modify `js/main.js` (рядом с блоком «Новости»), `css/styles.css`, `tests/app/server.mjs` (таблица `admin_events` + запись событий в заглушках заявок), Create `tests/app/t_events.py`; Modify `tests/README.md`, `CLAUDE.md`.

**Interfaces — Consumes:** Task 1. **Produces:** `startEvents()`, `stopEvents()`, `eventsRow()`, `openEvents()`; localStorage `events-seen-<id>` (последний увиденный id).

- [ ] Шаг 1: `t_events.py`: (a) у обычного человека строки «События» нет; (b) у создателя есть; (c) покупатель шлёт заявку на Премиум → у создателя без перезагрузки счётчик 1 и тост; (d) открыл список → запись с ником и «2 000 ₽», счётчик 0; (e) нажал на запись → открылся магазин на вкладке «Заявки»; (f) ник `<b>x</b>` в тексте виден буквально; (g) нет ошибок JS; (h) нет горизонтальной прокрутки на 375.
- [ ] Шаг 2: прогнать — падает на (b).
- [ ] Шаг 3: реализовать; `go`: `orders` → `openShop('orders')`, `user:<ник>` → `openAdmin('people')` с подставленным поиском, `nodes` → окно партнёров, иначе ничего.
- [ ] Шаг 4: `t_events.py` зелёный; регрессия: t_basic, t_shop, t_premium, t_admin, t_pins_news, t_layout.
- [ ] Шаг 5: bump, commit, push.

### Task 3: рабочая база
- [ ] Попросить «применяй update-23», применить, проверить запросом, что таблица и триггеры есть; попросить владельца сделать тестовую заявку и увидеть событие.
