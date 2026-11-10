# Админка создателя: статистика, люди, роль, значок другому, бан/разбан; смена ника раз в 30 дней со старым ником-переадресацией
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

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    a = User(br, 'alice').signup()
    b = User(br, 'bobby', 375, 667, True).signup()
    c = User(br, 'carol').signup()
    api('role', {'username': 'alice', 'role': 'creator'})
    for u in (a, b, c): u.page.on('dialog', lambda d: d.accept())
    a.open_dm('bobby'); a.send('привет')
    relog(a)
    p = a.page
    p.click('#settingsBtn')
    p.locator('.section', has_text='Админка').locator('button', has_text='Открыть').click()
    p.wait_for_selector('.stat-tile')
    check('статистика: людей 3', '3' in p.locator('.stat-tile', has_text='Людей').inner_text())
    a.shot('admin_stats')
    p.locator('.segmented button', has_text='Люди').click(); p.wait_for_selector('.admin-user')
    check('в списке 3 человека', p.locator('.admin-user').count() == 3)
    p.locator('.admin input').fill('bob'); time.sleep(0.8)
    check('поиск находит bobby', p.locator('.admin-user').count() == 1)
    p.locator('.admin-user').click(); p.wait_for_selector('.modal-head', has_text='@bobby') if False else time.sleep(0.6)
    # роль тестер
    p.locator('.section', has_text='Роль').locator('label.switch').click(); time.sleep(1)
    check('bobby стал тестером', p.locator('.profile-head .role.tester').count() >= 1)
    # значок другому
    p.locator('.section', has_text='Значки').locator('.row', has=p.locator('.role.donor')).locator('label.switch').click(); time.sleep(1)
    check('bobby выдан донатер', p.locator('.profile-head .role.donor').count() == 1)
    a.shot('admin_user')
    # бан
    p.locator('.ban-box input').fill('спам'); p.locator('.ban-box button', has_text='1 день').click(); time.sleep(1)
    check('bobby забанен (видно в карточке)', 'Забанен до' in p.inner_text('.modal'))
    b.open_chat('alice'); b.page.fill('#text', 'я забанен?'); b.page.click('#sendBtn'); time.sleep(1.2)
    check('забаненный не может отправить', 'заблокирован' in b.page.inner_text('body'))
    p.locator('.ban-box button', has_text='Разбанить').click(); time.sleep(1)
    check('разбанен', 'Забанен до' not in p.inner_text('.modal'))
    p.keyboard.press('Escape')
    # смена ника у carol
    cp = c.page
    cp.click('#settingsBtn'); cp.locator('.section', has_text='Профиль').locator('button', has_text='Сменить').click()
    cp.locator('.modal input').fill('carol_new'); cp.locator('.modal .btn-primary', has_text='Сохранить').click(); time.sleep(1)
    check('ник сменился', '@carol_new' in cp.inner_text('#meNick'))
    cp.locator('.section', has_text='Профиль').locator('button', has_text='Сменить').click()
    cp.locator('.modal input').fill('carol_two'); cp.locator('.modal .btn-primary', has_text='Сохранить').click(); time.sleep(1)
    check('второй раз сразу нельзя (раз в 30 дней)', 'раз в 30 дней' in cp.inner_text('.modal .note'))
    cp.keyboard.press('Escape')
    # старый ник ведёт на carol
    p.fill('#findInput', 'carol'); p.press('#findInput', 'Enter'); time.sleep(1.5)
    check('по старому нику открылся чат с carol', 'carol_new' in p.inner_text('#chatTitle') or 'carol' in p.inner_text('#chatTitle'))
    for u in (a, b, c):
        errs = [e for e in u.errors if 'ERR_' not in e]
        check(f'нет ошибок JS ({u.nick})', not errs)
        if errs: print('\n'.join(errs[:5]))
    br.close()
print('ИТОГ:', sum(1 for _, x in ok if x), '/', len(ok))
