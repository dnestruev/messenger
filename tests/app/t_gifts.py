# Подарки (update-29): заявка → создатель подтверждает → подарок с номером в профиле получателя
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *
reset(); ok = []
def check(name, cond):
    ok.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    boss = User(br, 'boss').signup(); api('role', {'username': 'boss', 'role': 'creator'})
    a = User(br, 'alice').signup()
    b = User(br, 'bobby', 375, 667, True).signup()
    for u in (boss, a, b): u.page.on('dialog', lambda d: d.accept())
    boss.page.reload(); boss.page.wait_for_selector('.chat-item'); time.sleep(0.8)
    a.open_dm('bobby'); a.send('привет'); time.sleep(0.6)
    p = a.page
    # из профиля друга
    p.locator('#chatInfo').click(); time.sleep(0.8)
    if not p.locator('.btn-gift').count():
        p.locator('.member.clickable, .member').filter(has_text='bobby').first.click(); time.sleep(0.6)
    check('в профиле друга кнопка «Подарить»', p.locator('.btn-gift', has_text='Подарить').count() >= 1)
    p.locator('.btn-gift', has_text='Подарить').first.click(); time.sleep(0.8)
    check('окно подарка: виски 300 ₽, получатель подставлен', 'Виски «Дельта»' in p.inner_text('.modal') and '300 ₽' in p.inner_text('.modal') and p.input_value('.modal input[placeholder="Кому: @ник"]') == '@bobby')
    p.fill('.modal textarea[placeholder^="Подпись"]', 'Держи, бро')
    p.locator('.modal .btn-gift', has_text='Я оплатил').click(); time.sleep(0.4)
    check('без доната — подсказка', 'от 5 символов' in p.inner_text('.modal'))
    p.fill('.modal textarea[placeholder^="Ссылка"]', 'донат 300 от alice')
    p.locator('.modal .btn-gift', has_text='Я оплатил').click(); time.sleep(1)
    check('заявка в «Мои»', '🎁 Виски «Дельта» → @bobby' in p.inner_text('.modal') and 'ждёт проверки' in p.inner_text('.modal'))
    # создатель подтверждает
    bp = boss.page
    tab(bp, 'admin'); bp.locator('.hub-item b', has_text='Заявки').click(); time.sleep(1)
    check('у создателя заявка на подарок', '@alice → @bobby' in bp.inner_text('.shop') and 'Держи, бро' in bp.inner_text('.shop'))
    bp.locator('.order-card button', has_text='подарить').click(); time.sleep(1)
    check('заявок больше нет', 'Новых заявок нет' in bp.inner_text('.shop'))
    # bobby получает: окно-сюрприз
    b.page.reload(); b.page.wait_for_selector('.chat-item'); time.sleep(0.5)
    b.page.reload(); b.page.wait_for_selector('.chat-item'); time.sleep(2)
    first = b.page.locator('.gift-card').count()
    if not first:   # первый запуск только запоминает, второй — показывает новые
        pass
    profile_page(b.page); time.sleep(1)
    check('в профиле bobby полка: 1 подарок №1', b.page.locator('.gift-tile').count() == 1 and '№1' in b.page.inner_text('.gift-shelf'))
    b.page.locator('.gift-tile').click(); time.sleep(0.6)
    check('карточка подарка: от alice и подпись', 'alice' in b.page.inner_text('.gift-card') and 'Держи, бро' in b.page.inner_text('.gift-card'))
    b.shot('gift_card_375')
    b.page.locator('.gift-card label.switch').click(); time.sleep(0.8)
    check('скрыл — помечен замком', b.page.locator('.gift-tile.hidden-gift').count() == 1)
    # создатель видит у bobby — нет (скрыт); дарит сам бесплатно второй
    tab(bp, 'shop'); bp.locator('#pageView button', has_text='Выбрать подарок').click(); time.sleep(0.6)
    bp.fill('#pageView input[placeholder="Кому: @ник"]', '@bobby')
    check('создателю — бесплатно', 'бесплатно' in bp.inner_text('#pageView'))
    bp.locator('#pageView .btn-gift', has_text='Подарить').last.click(); time.sleep(1)
    b.page.reload(); b.page.wait_for_selector('.chat-item'); time.sleep(2.5)
    check('новый подарок — окно-сюрприз у получателя', b.page.locator('.gift-card').count() == 1 and '№2' in b.page.inner_text('.gift-card'))
    b.page.keyboard.press('Escape'); time.sleep(0.3)
    # чужой профиль: alice видит у bobby только открытый №2
    a.page.reload(); a.page.wait_for_selector('.chat-item'); a.open_chat('bobby'); a.page.locator('#chatInfo').click(); time.sleep(1)
    if not a.page.locator('.gift-shelf').count():
        a.page.locator('.member').filter(has_text='bobby').first.click(); time.sleep(0.8)
    check('другие видят только не скрытые (1 шт.)', a.page.locator('.gift-tile').count() == 1)
    for w, hh in ((320, 568), (1440, 900)):
        b.page.set_viewport_size({'width': w, 'height': hh}); profile_page(b.page); time.sleep(0.5)
        check(f'{w}x{hh}: профиль без горизонтальной прокрутки', b.page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
    errs = [e for e in boss.errors + a.errors + b.errors if 'pageerror' in e]
    check('нет ошибок JS', not errs); print(errs[:3]) if errs else None
    br.close()
print(f"\n{sum(c for _, c in ok)}/{len(ok)} passed")
