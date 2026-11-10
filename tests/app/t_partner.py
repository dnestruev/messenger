# Уровни партнёров, TURN партнёра, значки статусов, донаты
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

reset()
ok = []
def relog(u):
    u.page.reload(); u.page.wait_for_selector('.chat-item, .modal input[type=password]', timeout=20000)
    if u.page.locator('.modal input[type=password]').count():
        u.page.fill('.modal input[type=password]', 'секретный код 1'); u.page.click('.modal .btn-primary')
        u.page.wait_for_selector('.modal', state='detached', timeout=20000)
    u.page.wait_for_selector('.chat-item')
def check(name, cond):
    ok.append((name, bool(cond)))
    print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    a = User(br, 'alice').signup()
    b = User(br, 'bobby', 375, 667, True).signup()
    api('role', {'username': 'alice', 'role': 'creator'})
    api('partner', {'username': 'bobby'})
    for u in (a, b): u.page.on('dialog', lambda d: d.accept())
    a.open_dm('bobby'); a.send('привет, партнёр')
    relog(a)
    item = a.page.locator('.chat-item', has=a.page.locator('.chat-item-name', has_text='bobby'))
    check('в списке у Алисы бронзовый значок (иконкой)', item.locator('.role.tier-bronze.mini').count() == 1)
    a.open_chat('bobby')
    check('в шапке тоже бронза', a.page.locator('#chatTitle .role.tier-bronze, .chat-head .role.tier-bronze').count() >= 1)
    # карточка статуса
    a.page.locator('.chat-head .role.tier-bronze, #chatTitle .role.tier-bronze').first.click()
    a.page.wait_for_selector('.status-check.verified', timeout=5000)
    print(a.page.inner_text('.status-info-card')[:300]); check('карточка: бронза подтверждена', 'Бронза' in a.page.inner_text('.status-info-card'))
    check('карточка: «Как получить»', 'Как получить' in a.page.inner_text('.status-info-card'))
    a.shot('status_card'); a.page.keyboard.press('Escape')

    # Боб: лестница уровней и TURN
    b.page.click('#meBtn'); b.page.wait_for_selector('.tier-ladder .tier-step')
    steps = b.page.locator('.tier-step')
    check('лестница: бронза ✓, серебро и золото — нет', steps.nth(0).get_attribute('class').endswith('done') and 'done' not in steps.nth(1).get_attribute('class'))
    b.page.locator('.turn-form input').nth(0).fill('relay1.expressturn.com:3478')
    b.page.locator('.turn-form input').nth(1).fill('bad'); b.page.locator('.turn-form input').nth(2).fill('x')
    b.page.locator('.turn-form button', has_text='Добавить и проверить').click()
    b.page.wait_for_selector('.turn-state.failing', timeout=8000)
    check('неверный TURN — «не отвечает»', 'неверный логин' in b.page.inner_text('.modal'))
    b.page.locator('.turn-form input').nth(0).fill('turn:relay2.expressturn.com:3478')
    b.page.locator('.turn-form input').nth(1).fill('good'); b.page.locator('.turn-form input').nth(2).fill('секрет')
    b.page.locator('.turn-form button', has_text='Добавить и проверить').click()
    b.page.wait_for_selector('.turn-state.active', timeout=8000)
    check('рабочий TURN — «работает»', True)
    check('третий TURN добавить нельзя (формы нет)', b.page.locator('.turn-form button', has_text='Добавить и проверить').count() == 0)
    b.page.wait_for_function("document.querySelectorAll('.tier-step.done').length === 2", timeout=8000)
    check('лестница: серебро ✓', True)
    check('золото: прогресс 0 из 30', '0 из 30' in b.page.inner_text('.tier-ladder'))
    check('у себя в профиле серебро', b.page.locator('.profile-head .role.tier-silver').count() == 1)
    pw_seen = any('секрет' in str(r) for r in [debug()['db']['turn_providers']])
    b.shot('tier_ladder')
    b.page.keyboard.press('Escape')

    # Алиса (создатель): ссылка на донаты и значок донатеру
    a.page.click('#settingsBtn')
    adm = a.page.locator('.section', has_text='Донаты (видно только вам)')
    adm.locator('input').nth(0).fill('javascript:alert(1)')
    adm.locator('button', has_text='Сохранить ссылку').click(); time.sleep(0.5)
    check('плохая ссылка не сохраняется', 'https://' in a.page.inner_text('.modal .note'))
    adm.locator('input').nth(0).fill('https://www.donationalerts.com/r/messenger')
    adm.locator('button', has_text='Сохранить ссылку').click(); time.sleep(0.5)
    adm.locator('input').nth(1).fill('bobby'); adm.locator('button', has_text='Выдать').click(); time.sleep(0.8)
    check('донатер выдан', 'bobby' in adm.inner_text())
    a.page.keyboard.press('Escape'); time.sleep(0.3)
    # Боб видит ссылку и свой новый значок (обновление значков)
    relog(b)
    b.page.click('#meBtn'); b.page.wait_for_selector('.donate-card')
    href = b.page.get_attribute('.donate-card a', 'href')
    check('кнопка «Поддержать» ведёт на ссылку', href == 'https://www.donationalerts.com/r/messenger')
    check('у Боба значки серебро + донатер', b.page.locator('.profile-head .role.tier-silver').count() == 1 and b.page.locator('.profile-head .role.donor').count() == 1)
    b.shot('donate_mobile')
    check('не создатель не видит админку донатов', b.page.locator('.section', has_text='Донаты (видно только вам)').count() == 0)
    b.page.keyboard.press('Escape')
    # тёмная тема — скриншот значков в списке
    relog(a)
    a.open_chat('bobby'); time.sleep(0.5); a.shot('badges_light')
    a.page.evaluate("document.documentElement.dataset.mode = 'dark'"); time.sleep(0.4); a.shot('badges_dark')
    for u in (a, b):
        errs = [e for e in u.errors if 'ERR_' not in e]
        check(f'нет ошибок JS ({u.nick})', not errs)
        if errs: print('\n'.join(errs[:8]))
    br.close()
print('ИТОГ:', sum(1 for _, x in ok if x), '/', len(ok))
