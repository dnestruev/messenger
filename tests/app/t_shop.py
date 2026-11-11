# Магазин лимиток: витрина, заявка, выдача создателем, значок у ника, перепродажа напрямую (без комиссии), правка цены/тиража
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

reset()
ok = []
def check(name, cond):
    ok.append((name, bool(cond)))
    print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
def shop(p, tab=None):
    if not p.locator('.shop').count():
        if not p.locator('.modal').count(): p.click('#settingsBtn')
        p.locator('.section', has_text='Магазин лимиток').locator('button', has_text='Открыть').click()
    p.wait_for_selector('.shop')
    if tab: p.locator('.segmented button', has_text=tab).click()
    time.sleep(0.7)
def card(p, name): return p.locator('.shop-card', has=p.locator('.role', has_text=name))

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    a = User(br, 'alice').signup()                       # создатель
    b = User(br, 'bobby', 375, 667, True).signup()       # покупатель (телефон)
    c = User(br, 'carol', 320, 568, True).signup()       # второй покупатель (маленький телефон)
    api('role', {'username': 'alice', 'role': 'creator'})
    errs = []
    for u in (a, b, c):
        u.page.on('pageerror', lambda e: errs.append(str(e))); u.page.on('dialog', lambda d: d.accept())
        u.page.reload(); u.page.wait_for_selector('.chat-item')
    a.open_dm('bobby'); a.send('привет'); time.sleep(1)

    shop(b.page)
    check('витрина: 20 статусов', b.page.locator('.shop-card').count() == 20)
    check('самый дорогой первым, 20 000 ₽, тираж 1', 'Абсолют' in b.page.locator('.shop-card').first.inner_text() and '20 000 ₽' in b.page.locator('.shop-card').first.inner_text() and 'осталось 1 из 1' in b.page.locator('.shop-card').first.inner_text())
    check('обычный человек не видит «Заявки» и «Изменить»', b.page.locator('.segmented button', has_text='Заявки').count() == 0 and b.page.locator('.shop-card button', has_text='Изменить').count() == 0)
    b.shot('shop_phone')
    card(b.page, 'Абсолют').locator('button', has_text='Купить').click()
    b.page.locator('.modal button', has_text='Я оплатил').click()
    time.sleep(0.8)
    check('без подтверждения заявка не уходит', b.page.locator('.modal .note.err').count() == 1 and 'донат' in b.page.inner_text('.modal .note.err'))
    b.page.fill('.modal textarea', 'донат от bobby, 20000, 20:15'); b.shot('shop_buy')
    b.page.locator('.modal button', has_text='Я оплатил').click(); b.page.wait_for_selector('.shop'); time.sleep(0.6)
    check('заявка в «Мои» ждёт проверки', 'ждёт проверки' in b.page.inner_text('.shop'))
    shop(c.page)
    check('тираж занят заявкой — купить нельзя', card(c.page, 'Абсолют').locator('button', has_text='Купить').count() == 0)
    c.shot('shop_320')

    shop(a.page, 'Заявки')
    check('создатель видит заявку с подтверждением', '@bobby' in a.page.inner_text('.shop') and '20:15' in a.page.inner_text('.shop'))
    a.shot('shop_orders')
    a.page.locator('.order-card button', has_text='выдать').click(); time.sleep(1)
    check('после выдачи заявок нет', 'Новых заявок нет' in a.page.inner_text('.shop'))
    b.page.reload(); b.page.wait_for_selector('.chat-item')
    check('значок виден у ника', b.page.wait_for_function("!!document.querySelector('#meName, .me, body') && !!document.querySelector('.role.l-absolute')", timeout=8000) is not None)
    a.page.reload(); a.page.wait_for_selector('.chat-item')
    check('значок видят другие (в списке чатов)', a.page.locator('.chat-item .role.l-absolute').count() >= 1)
    a.shot('shop_badge_in_list')

    # перепродажа напрямую
    shop(b.page, 'Мои')
    check('в «Мои» экземпляр №1', '№1' in b.page.inner_text('.shop'))
    b.page.locator('.shop-card button', has_text='Продать').click()
    check('в продаже нет слова «комиссия 10%»', '10%' not in b.page.inner_text('.modal'))
    b.page.fill('.modal input[type=number]', '30000'); b.page.locator('.modal button', has_text='Выставить').click(); b.page.wait_for_selector('.shop'); time.sleep(0.6)
    shop(c.page, 'С рук')
    check('на рынке за 30 000 ₽', '30 000 ₽' in c.page.inner_text('.shop') and '@bobby' in c.page.inner_text('.shop'))
    c.page.locator('.shop-card button', has_text='Купить').click(); c.shot('shop_resale_buy')
    c.page.locator('.modal button', has_text='Отправить заявку продавцу').click(); c.page.wait_for_selector('.shop'); time.sleep(0.6)
    shop(a.page, 'Заявки')
    check('создателю сделка с рук не приходит', 'Новых заявок нет' in a.page.inner_text('.shop'))
    b.page.locator('.segmented button', has_text='С рук').click(); time.sleep(0.4); b.page.locator('.segmented button', has_text='Мои').click(); time.sleep(0.8)
    check('продавец видит заявку покупателя', 'Хотят купить у вас' in b.page.inner_text('.shop') and '@carol' in b.page.inner_text('.shop'))
    b.shot('shop_seller_request')
    b.page.locator('.order-card button', has_text='передать').click(); time.sleep(1.2)
    check('у продавца статуса больше нет', 'Пока ни одного' in b.page.inner_text('.shop'))
    c.page.locator('.segmented button', has_text='Мои').click(); time.sleep(0.8)
    check('у покупателя статус №1', '№1' in c.page.inner_text('.shop') and 'выдан' in c.page.inner_text('.shop'))

    # создатель правит цену и тираж
    shop(a.page, 'Витрина')
    card(a.page, 'Искра').locator('button', has_text='Изменить').click()
    a.page.locator('.modal input[type=number]').nth(0).fill('750'); a.page.locator('.modal input[type=number]').nth(1).fill('5')
    a.page.locator('.modal button', has_text='Сохранить').click(); a.page.wait_for_selector('.shop'); time.sleep(0.6)
    check('цена и тираж изменены', '750 ₽' in card(a.page, 'Искра').inner_text() and 'из 5' in card(a.page, 'Искра').inner_text())
    card(a.page, 'Абсолют').locator('button', has_text='Изменить').click()
    a.page.locator('.modal input[type=number]').nth(1).fill('0'); a.page.locator('.modal button', has_text='Сохранить').click(); time.sleep(0.5)
    check('тираж ниже проданного нельзя', a.page.locator('.note.err').count() == 1)
    for u, n in ((b, 375), (c, 320)):
        check(f'нет горизонтальной прокрутки на {n}', not u.page.evaluate("document.documentElement.scrollWidth > innerWidth + 1"))
    check('нет ошибок JS', not errs); print(errs[:3])
    br.close()
print('ИТОГ:', sum(1 for _, c in ok if c), '/', len(ok))
