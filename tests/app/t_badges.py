# Значки: не больше двух + «+N» в списках, выбор показа в настройках (видят все), на телефоне шапка не распухает
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
    b = User(br, 'bobby', 360, 740, True).signup()
    api('role', {'username': 'alice', 'role': 'creator'}); api('partner', {'username': 'alice'})
    for k in ('bro', 'relay', 'donor'): api('grant', {'username': 'alice', 'kind': k})
    a.open_dm('bobby'); a.send('привет')
    relog(a); relog(b)
    bp = b.page
    row = bp.locator('.chat-item', has=bp.locator('.chat-item-name', has_text='alice'))
    check('в списке: 2 значка и «+3»', row.locator('.role:not(.more)').count() == 2 and row.locator('.role.more').inner_text() == '+3')
    b.open_chat('alice'); time.sleep(0.5)
    t = bp.locator('#chatTitle .t').bounding_box()
    check('шапка на телефоне: имя видно, 1 значок + «+4»', bp.evaluate("(e => e.scrollWidth <= e.clientWidth + 1)(document.querySelector('#chatTitle .t'))") and bp.locator('#chatTitle .role:not(.more)').count() == 1 and bp.locator('#chatTitle .role.more').count() == 1)
    w = bp.evaluate("Math.max(...[...document.querySelectorAll('#chatTitle .role')].map(e => e.getBoundingClientRect().width))")
    check('значки в шапке маленькие (≤ 30px)', w <= 30)
    check('значки в шапке не обрезаются', bp.evaluate("(e => e.scrollWidth <= e.clientWidth + 1)(document.querySelector('#chatTitle .name-line'))"))
    b.shot('badges_head_mobile')
    bp.locator('#chatTitle .role.more').click(); bp.wait_for_selector('.badge-list .badge-row')
    check('«+N» открывает все 5 значков', bp.locator('.badge-row').count() == 5)
    b.shot('badges_all'); bp.keyboard.press('Escape'); time.sleep(0.3)
    # Алиса скрывает два значка
    p = a.page
    p.click('#settingsBtn'); sec = p.locator('.section', has_text='Значки у ника')
    check('в настройках 5 переключателей', sec.locator('.row').count() == 5)
    sec.locator('.row', has=p.locator('.role.donor')).locator('label.switch').click(); time.sleep(0.5)
    sec.locator('.row', has=p.locator('.role.relay')).locator('label.switch').click(); time.sleep(0.8)
    check('у себя в профиле осталось 3', p.locator('.modal .profile-head .name-line .role').count() == 3)
    a.shot('badges_settings')
    relog(b); b.open_chat('alice'); time.sleep(0.5)
    check('bobby видит только 3 (1 и «+2»)', bp.locator('#chatTitle .role:not(.more)').count() == 1 and bp.locator('#chatTitle .role.more').inner_text() == '+2')
    sec = p.locator('.section', has_text='Значки у ника')
    sec.locator('button', has_text='Скрыть все').click(); time.sleep(0.8)
    relog(b); b.open_chat('alice'); time.sleep(0.5)
    check('скрыла все — у bobby значков нет', bp.locator('#chatTitle .role').count() == 0)
    sec.locator('button', has_text='Показать все').click(); time.sleep(0.8)
    relog(a); p.click('#settingsBtn'); time.sleep(0.5)
    check('после перезагрузки выбор сохранён (все 5)', p.locator('.modal .profile-head .name-line .role').count() == 5)
    for u in (a, b):
        errs = [e for e in u.errors if 'ERR_' not in e]
        check(f'нет ошибок JS ({u.nick})', not errs)
        if errs: print('\n'.join(errs[:5]))
    br.close()
print('ИТОГ:', sum(1 for _, x in ok if x), '/', len(ok))
