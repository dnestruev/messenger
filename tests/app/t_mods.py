# Модераторы: урезанная админка модератора, старший модератор, выдача создателем на время, истечение срока
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

reset()
ok = []
def check(name, cond):
    ok.append((name, bool(cond)))
    print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
def relog(u):
    u.page.reload(); u.page.wait_for_selector('.chat-item, .modal input[type=password]', timeout=20000)
    if u.page.locator('.modal input[type=password]').count():
        u.page.fill('.modal input[type=password]', 'секретный код 1'); u.page.click('.modal .btn-primary')
        u.page.wait_for_selector('.modal', state='detached', timeout=20000)
    u.page.wait_for_selector('.chat-item')
def open_panel(p, name):
    p.click('#settingsBtn')
    p.locator('.section', has_text=name).locator('button', has_text='Открыть').click()
    p.wait_for_selector('.admin')
def open_user(p, nick):
    if p.locator('.segmented button', has_text='Люди').count(): p.locator('.segmented button', has_text='Люди').click()
    p.wait_for_selector('.admin-user')
    p.locator('.admin input').fill(nick); time.sleep(0.8)
    p.locator('.admin-user').first.click(); time.sleep(0.6)

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    a = User(br, 'alice').signup()                     # создатель
    m = User(br, 'mod1', 375, 667, True).signup()      # модератор (телефон)
    s = User(br, 'senior1').signup()                   # старший
    v = User(br, 'victim').signup()
    api('role', {'username': 'alice', 'role': 'creator'})
    for u in (a, m, s, v): u.page.on('dialog', lambda d: d.accept())
    relog(a)
    # обычный человек админку не видит
    m.page.click('#settingsBtn'); time.sleep(0.5)
    check('без прав раздела «Модерация» нет', m.page.locator('.section', has_text='Модерация').count() == 0)
    m.page.keyboard.press('Escape')
    # создатель назначает: mod1 — модератор без срока, senior1 — старший на 30 минут
    p = a.page
    open_panel(p, 'Админка'); open_user(p, 'mod1')
    p.locator('.section', has_text='Модератор').locator('button', has_text='Модератор').click(); time.sleep(1)
    check('mod1 — модератор (значок в карточке)', p.locator('.profile-head .role.moderator').count() == 1)
    check('написано «без срока»', 'Модератор без срока' in p.inner_text('.modal'))
    p.locator('button', has_text='К списку').click(); open_user(p, 'senior1')
    p.locator('.section', has_text='Модератор').locator('select').select_option('30')
    p.locator('.section', has_text='Модератор').locator('button', has_text='Старший').click(); time.sleep(1)
    check('senior1 — старший (значок)', p.locator('.profile-head .role.senior').count() == 1)
    check('виден срок', 'Старший модератор до' in p.inner_text('.modal'))
    a.shot('mods_creator_user')
    p.keyboard.press('Escape')
    # модератор: урезанная панель
    relog(m); mp = m.page
    open_panel(mp, 'Модерация')
    check('у модератора нет вкладок статистики/журнала', mp.locator('.modal .segmented button', has_text='Статистика').count() == 0 and mp.locator('.modal .segmented button', has_text='Журнал').count() == 0 and mp.locator('.stat-tile').count() == 0)
    check('подпись «Вы — модератор»', 'Вы — модератор' in mp.inner_text('.modal'))
    m.shot('mods_mod_panel')
    open_user(mp, 'victim')
    txt = mp.inner_text('.modal')
    check('модератору не видны роли и значки', 'Роль «Тестер»' not in txt and 'выдать вручную' not in txt and 'Старший' not in txt)
    check('у модератора нет «Навсегда» и «30 дней»', mp.locator('.ban-box button', has_text='Навсегда').count() == 0 and mp.locator('.ban-box button', has_text='30 дней').count() == 0)
    mp.locator('.ban-box input').fill('спам'); mp.locator('.ban-box button', has_text='7 дней').click(); time.sleep(1)
    check('модератор забанил на 7 дней', 'Забанен до' in mp.inner_text('.modal') and '@mod1' in mp.inner_text('.modal'))
    m.shot('mods_mod_user')
    mp.locator('.ban-box button', has_text='Разбанить').click(); time.sleep(1)
    check('модератор разбанил', 'Забанен до' not in mp.inner_text('.modal'))
    mp.locator('button', has_text='К списку').click(); open_user(mp, 'senior1')
    check('старшего модератор забанить не может', mp.locator('.ban-box').count() == 0 and 'забанить не можете' in mp.inner_text('.modal'))
    mp.locator('button', has_text='К списку').click(); open_user(mp, 'alice')
    check('создателя модератор забанить не может', mp.locator('.ban-box').count() == 0)
    mp.keyboard.press('Escape')
    # старший: статистика + навсегда + бан модератора
    relog(s); sp = s.page
    open_panel(sp, 'Модерация')
    sp.wait_for_selector('.stat-tile')
    check('старший видит статистику', sp.locator('.stat-tile').count() >= 5)
    check('у старшего нет журнала', sp.locator('.segmented button', has_text='Журнал').count() == 0)
    check('у старшего виден срок', 'старший модератор до' in sp.inner_text('.modal'))
    s.shot('mods_senior_panel')
    open_user(sp, 'victim')
    sp.locator('.ban-box button', has_text='Навсегда').click(); time.sleep(1)
    check('старший забанил навсегда', 'Забанен навсегда' in sp.inner_text('.modal'))
    sp.keyboard.press('Escape')
    # модератор не снимает бан старшего
    open_panel(mp, 'Модерация'); open_user(mp, 'victim')
    mp.locator('.ban-box button', has_text='Разбанить').click(); time.sleep(1)
    check('модератор не снимает бан старшего', 'поставил старший' in mp.inner_text('.modal') and 'Забанен навсегда' in mp.inner_text('.modal'))
    mp.keyboard.press('Escape')
    # журнал у создателя
    open_panel(p, 'Админка')
    p.locator('.segmented button', has_text='Журнал').click(); p.wait_for_selector('.log-row')
    check('журнал: есть записи о банах', p.locator('.log-row', has_text='забанил').count() >= 2 and p.locator('.log-row', has_text='назначил').count() == 2)
    a.shot('mods_log')
    p.keyboard.press('Escape')
    # значок виден другим
    v2 = User(br, 'watcher').signup(); v2.open_dm('mod1'); time.sleep(1)
    check('значок модератора виден в шапке чата другим', v2.page.locator('#chatHeader .role.moderator, .chat-head .role.moderator, header .role.moderator').count() >= 1)
    # срок вышел: права пропадают
    api('mod', {'username': 'senior1', 'level': 'senior', 'seconds': 1}); time.sleep(1.5)
    open_panel(sp, 'Модерация'); time.sleep(1)
    check('срок вышел: сервер не пускает', 'Недостаточно прав' in sp.inner_text('.modal'))
    sp.keyboard.press('Escape')
    relog(s); sp.click('#settingsBtn'); time.sleep(0.5)
    check('срок вышел: раздел исчез', sp.locator('.section', has_text='Модерация').count() == 0)
    for u in (a, m, s, v, v2):
        errs = [e for e in u.errors if 'ERR_' not in e]
        check(f'нет ошибок JS ({u.nick})', not errs)
        if errs: print('\n'.join(errs[:5]))
    br.close()
print('ИТОГ:', sum(1 for _, x in ok if x), '/', len(ok))
