# Премиум: покупка, выдача создателем, значок, цветной ник, темы, рамки, скидка на лимитки, файлы 25 МБ, снятие
import os, sys, time, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

reset()
ok = []
def check(name, cond):
    ok.append((name, bool(cond)))
    print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
def settings(p):
    if not p.locator('.modal').count(): p.click('#settingsBtn')
    p.wait_for_selector('.modal .section'); time.sleep(0.4)
def shop(p, tab=None):
    if not p.locator('.shop').count():
        settings(p); p.locator('.section', has=p.locator('h3, .section-title, b', has_text=re.compile('^Магазин$'))).last.locator('button', has_text='Открыть').click()
    p.wait_for_selector('.shop')
    if tab: p.locator('.segmented button', has_text=tab).click()
    time.sleep(0.8)
def back(p): p.locator('.modal button', has_text='Назад в настройки').click(); time.sleep(0.5)

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    a = User(br, 'alice').signup()                       # создатель
    b = User(br, 'bobby', 375, 667, True).signup()       # покупатель
    api('role', {'username': 'alice', 'role': 'creator'})
    errs = []
    for u in (a, b):
        u.page.on('pageerror', lambda e: errs.append(str(e))); u.page.on('dialog', lambda d: d.accept())
        u.page.reload(); u.page.wait_for_selector('.chat-item')
    a.open_dm('bobby'); a.send('привет'); time.sleep(1)

    settings(b.page)
    sec = b.page.locator('.section', has_text='Оформить Премиум')
    check('раздел «Премиум» в настройках, цены видны', sec.count() == 1 and '2 000 ₽' in sec.inner_text() and '24 000 ₽' in sec.inner_text())
    check('без премиума нет выбора цвета ника', b.page.locator('.nick-colors').count() == 0)
    sec.locator('button', has_text='Оформить Премиум').click(); b.page.wait_for_selector('.shop'); time.sleep(0.8)
    card = b.page.locator('.premium-card')
    check('карточка Премиума на витрине с двумя ценами', 'Месяц — 2 000 ₽' in card.inner_text() and 'Год — 24 000 ₽' in card.inner_text())
    check('покупателю не видно «подарить»', b.page.locator('.premium-gift').count() == 0)
    b.shot('premium_shop')
    card.locator('button', has_text='Месяц').click()
    b.page.fill('.modal textarea', 'донат bobby 2000 в 22:10'); b.page.locator('.modal button', has_text='Я оплатил').click()
    b.page.wait_for_selector('.shop'); time.sleep(0.6)
    check('заявка на Премиум ждёт проверки', 'Премиум на месяц' in b.page.inner_text('.shop') and 'ждёт проверки' in b.page.inner_text('.shop'))

    shop(a.page, 'Заявки')
    check('создатель видит заявку', 'Премиум на месяц · 2 000 ₽' in a.page.inner_text('.shop') and '@bobby' in a.page.inner_text('.shop'))
    a.page.locator('.order-card button', has_text='включить').click(); time.sleep(1.2)
    check('заявок больше нет', 'Новых заявок нет' in a.page.inner_text('.shop'))

    b.page.reload(); b.page.wait_for_selector('.chat-item'); time.sleep(1.5)
    check('значок Премиум у ника', b.page.locator('#meName .role.premium').count() == 1 and b.page.locator('#meName .role.plus').count() == 0)
    settings(b.page)
    sec = b.page.locator('.section', has=b.page.locator('.nick-colors'))
    check('в разделе срок действия и «Продлить»', 'Действует до' in sec.inner_text() and sec.locator('button', has_text='Продлить').count() == 1)
    sec.locator('.nick-pick', has_text='Радуга').click(); time.sleep(0.8)
    check('цветной ник у себя', b.page.locator('#meName .t.nick-rainbow').count() == 1)
    sec.locator('.segmented button', has_text='Закат').click(); time.sleep(0.8)
    check('тема «Закат» включилась', b.page.evaluate("document.documentElement.dataset.style") == 'sunset')
    b.shot('premium_settings')
    check('рамки Премиума доступны', b.page.locator('.frame-pick', has_text='Огонь').count() == 1 and b.page.locator('.frame-pick', has_text='Призма').count() == 1)
    b.page.locator('.frame-pick', has_text='Огонь').click(); time.sleep(0.8)
    check('рамка «Огонь» на аватарке', b.page.locator('.avatar.frame-fire').count() >= 1)
    shop(b.page)
    spark = b.page.locator('.shop-card', has=b.page.locator('.role > span', has_text=re.compile('^Искра$')))
    check('скидка 10% на лимитки: 630 ₽ вместо 700 ₽', '630 ₽' in spark.inner_text() and '700 ₽' in spark.inner_text())
    a.page.reload(); a.page.wait_for_selector('.chat-item'); time.sleep(1.5)
    check('другие видят значок и цветной ник в списке чатов', a.page.locator('.chat-item .role.premium').count() >= 1 and a.page.locator('.chat-item .t.nick-rainbow').count() >= 1)
    a.shot('premium_seen_by_others')

    # создатель дарит и снимает
    shop(a.page, 'Витрина')
    a.page.fill('.premium-gift input', 'bobby'); a.page.locator('.premium-gift button', has_text='Снять').click(); time.sleep(1.2)
    b.page.reload(); b.page.wait_for_selector('.chat-item'); time.sleep(1.5)
    check('после снятия: значка нет, тема вернулась к обычной, рамка не видна', b.page.locator('#meName .role.premium').count() == 0 and b.page.evaluate("document.documentElement.dataset.style") == 'classic' and b.page.locator('.avatar.frame-fire').count() == 0)
    a.page.locator('.premium-gift button', has_text='+30 дней').click(); time.sleep(1.2)
    b.page.reload(); b.page.wait_for_selector('.chat-item'); time.sleep(1.5)
    check('подарок создателя включил Премиум', b.page.locator('#meName .role.premium').count() == 1)
    check('нет горизонтальной прокрутки на 375', not b.page.evaluate("document.documentElement.scrollWidth > innerWidth + 1"))
    check('нет ошибок JS', not errs); print(errs[:3])
    br.close()
print('ИТОГ:', sum(1 for _, c in ok if c), '/', len(ok))
