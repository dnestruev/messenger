# Ивент «Фортуна»: плашка, рулетка, выигрыш, «Удача» с анимацией, покупка круток, заявки у создателя, конец ивента
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *
reset(); ok = []
def check(name, cond):
    ok.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
def close_all(p):
    for _ in range(4):
        if p.locator('.modal').count() == 0: break
        p.keyboard.press('Escape'); time.sleep(0.25)
def shop(p, tab):
    close_all(p); p.click('#settingsBtn'); time.sleep(0.6)
    p.locator('.section', has_text='Лимитированные статусы').locator('button', has_text='Открыть').click(); p.wait_for_selector('.shop')
    if tab != 'Витрина': p.locator('.segmented button', has_text=tab).click()
    time.sleep(0.8)
def fortune(p):
    close_all(p); p.click('#settingsBtn'); time.sleep(0.6)
    p.locator('.section', has_text='Лимитированные статусы').locator('button', has_text='Крутить').click(); p.wait_for_selector('.fortune .reel-tile'); time.sleep(0.4)
def spin(p):
    p.locator('.fortune-spin').click()
    p.wait_for_function("!document.querySelector('.fortune-spin').disabled || document.querySelector('.fortune-result').textContent.length > 0", timeout=15000)
    p.wait_for_function("document.querySelector('.fortune-result').textContent.length > 0", timeout=15000)

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    boss = User(br, 'boss').signup(); api('role', {'username': 'boss', 'role': 'creator'})
    a = User(br, 'alice', 375, 667, True).signup()
    for u in (a, boss): u.page.on('dialog', lambda d: d.accept())
    a.page.reload(); a.page.wait_for_selector('.chat-item'); time.sleep(1)
    check('плашка «Фортуна» над чатами (3 бесплатные)', a.page.locator('.fortune-pill').count() == 1 and '3 бесплатные' in a.page.inner_text('.fortune-pill'))
    a.page.locator('.fortune-pill').click(); a.page.wait_for_selector('.fortune .reel-tile')
    t = a.page.inner_text('.modal')
    check('в окне шансы: 25% … 0,1%', '25%' in t and '0,1%' in t and 'только выбить' in t)
    check('3 бесплатных', '3 бесплатных' in a.page.inner_text('.fortune-info'))
    api('fortune', {'force': ['l_clover']})
    spin(a.page)
    check('выпал Клевер №1', a.page.locator('.fortune-win .role.l-clover').count() == 1 and '№1' in a.page.inner_text('.fortune-win'))
    check('бесплатных стало 2', '2 бесплатных' in a.page.inner_text('.fortune-info'))
    check('лента остановилась на выигрыше под указателем', a.page.evaluate("""(() => { const w = document.querySelector('.reel-tile.won'), m = document.querySelector('.reel-marker');
        const a = w.getBoundingClientRect(), b = m.getBoundingClientRect(); const c = b.left + b.width / 2; return a.left < c && a.right > c; })()"""))
    spin(a.page)
    check('пусто — «В этот раз пусто»', 'пусто' in a.page.inner_text('.fortune-result').lower())
    api('fortune', {'force': ['l_luck']})
    spin(a.page)
    check('«Удача» — полноэкранный взрыв', a.page.locator('.luck-burst .luck-title').count() == 1 and 'УДАЧА' in a.page.inner_text('.luck-burst'))
    time.sleep(1.6); a.shot('fortune_luck_375')
    a.page.locator('.luck-burst').click(); time.sleep(0.3)
    check('бесплатные кончились — кнопка выключена', a.page.locator('.fortune-spin').is_disabled() and '00:00' in a.page.inner_text('.fortune-spin'))
    check('нет горизонтальной прокрутки на 375', a.page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
    check('окно «Фортуны» не шире экрана', a.page.evaluate("[...document.querySelectorAll('.fortune, .fortune-spin, .reel, .fortune-info')].every(e => e.getBoundingClientRect().right <= innerWidth + 1)"))
    a.shot('fortune_375')
    # покупка круток
    a.page.locator('.modal button', has_text='Докупить крутки').click(); a.page.wait_for_selector('.modal textarea')
    a.page.locator('.modal input[type=number]').fill('25'); a.page.locator('.modal input[type=number]').dispatch_event('input')
    check('25 круток — 2 300 ₽', '2 300 ₽' in a.page.inner_text('.modal'))
    a.page.fill('.modal textarea', 'донат 2300 от alice'); a.page.locator('.modal button', has_text='Отправить заявку').click(); time.sleep(1.2)
    # создатель начисляет
    boss.page.reload(); boss.page.wait_for_selector('.chat-item'); time.sleep(0.8)
    shop(boss.page, 'Заявки'); boss.page.wait_for_selector('.order-card')
    check('у создателя заявка на 25 круток', '25 круток' in boss.page.inner_text('.modal'))
    boss.page.locator('.modal button', has_text='Деньги пришли — начислить').click(); time.sleep(1)
    fortune(a.page)
    check('у человека 25 купленных', '25 купленных' in a.page.inner_text('.fortune-info'))
    spin(a.page)
    check('купленная крутка списалась (24)', '24 купленных' in a.page.inner_text('.fortune-info'))
    # прямая покупка: у Удачи кнопки нет, у Клевера есть
    prz = a.page.locator('.fortune-prize')
    check('купить Клевер напрямую за 500 ₽', prz.filter(has=a.page.locator('.role.l-clover')).locator('button', has_text='500 ₽').count() == 1)
    check('«Удачу» купить нельзя', prz.filter(has=a.page.locator('.role.l-luck')).locator('button').count() == 0)
    # статусы ивента не на общей витрине, а Удача в «Моих»
    shop(a.page, 'Витрина')
    check('на витрине карточка «Фортуна», но без призов ивента', a.page.locator('.fortune-card').count() == 1 and a.page.locator('.shop-card:not(.fortune-card) .role.l-clover').count() == 0)
    shop(a.page, 'Мои')
    check('в «Моих» Удача и Клевер', a.page.locator('.shop .role.l-luck').count() >= 1 and a.page.locator('.shop .role.l-clover').count() >= 1)
    # значок виден другим
    close_all(boss.page); boss.page.reload(); boss.page.wait_for_selector('.chat-item'); boss.open_dm('alice'); time.sleep(1)
    check('создатель видит у alice значок «Удача»', boss.page.locator('.role.l-luck').count() >= 1)
    # конец ивента
    api('fortune', {'off': True})
    close_all(a.page); a.page.reload(); a.page.wait_for_selector('.chat-item'); time.sleep(1)
    check('ивент кончился — плашки нет', a.page.locator('.fortune-pill').count() == 0)
    a.page.click('#settingsBtn'); time.sleep(0.6)
    check('ивент кончился — в настройках «Фортуны» нет', a.page.locator('.section', has_text='Лимитированные статусы').locator('button', has_text='Крутить').count() == 0)
    errs = [e for e in a.errors + boss.errors if 'pageerror' in e]
    check('нет ошибок JS', not errs); print(errs[:3]) if errs else None
    br.close()
print(f"\n{sum(c for _, c in ok)}/{len(ok)} passed")
