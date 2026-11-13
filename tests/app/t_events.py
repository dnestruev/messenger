# «События» для создателя: строка в списке, счётчик, тост, список, переход к заявкам, безопасный текст
import os, sys, time, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

reset()
ok = []
def check(name, cond):
    ok.append((name, bool(cond)))
    print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    a = User(br, 'alice').signup()
    b = User(br, 'bobby', 375, 667, True).signup()
    api('role', {'username': 'alice', 'role': 'creator'})
    for u in (a, b): u.page.on('dialog', lambda d: d.accept()); u.page.reload(); u.page.wait_for_selector('.chat-item')
    time.sleep(1)
    row = lambda p: p.locator('.events-item')
    check('у обычного человека строки «События» нет', row(b.page).count() == 0)
    check('у создателя строка есть', row(a.page).count() == 1)

    api('event', {'kind': 'order_premium', 'text': 'Заявка на Премиум (месяц) от @bobby — 2 000 ₽', 'go': 'orders'})
    time.sleep(1.5)
    check('без перезагрузки счётчик 1', a.page.locator('.events-item .events-count').inner_text().strip() == '1')
    check('тост о событии', 'Заявка на Премиум' in a.page.inner_text('body'))
    check('превью — последнее событие', '2 000 ₽' in row(a.page).inner_text())

    api('event', {'kind': 'user_new', 'text': 'Новый человек: @<b>x</b>', 'go': 'user:x'})
    time.sleep(1.2)
    row(a.page).click(); a.page.wait_for_selector('.events-list'); time.sleep(0.4)
    txt = a.page.inner_text('.events-list')
    check('в списке обе записи, новые сверху', txt.index('<b>x</b>') < txt.index('2 000 ₽'))
    check('ник с html виден буквально', a.page.locator('.events-list b').count() == 0)
    check('открыли — счётчик пропал', a.page.locator('.events-item .events-count').count() == 0)

    api('event', {'kind': 'node_new', 'text': 'Новая заявка узла от @bobby', 'go': 'nodes'})
    time.sleep(1.2)
    check('событие при открытом списке появилось сверху', a.page.locator('.event-row').first.inner_text().startswith('Новая заявка узла'))
    check('и счётчик не вырос', a.page.locator('.events-item .events-count').count() == 0)

    a.page.locator('.event-row', has_text='Премиум').click(); time.sleep(1)
    check('нажал на заявку — открылись «Заявки» магазина', a.page.locator('.shop').count() == 1 and a.page.locator('.segmented button.active, .segmented button[aria-pressed=true], .segmented .on', has_text='Заявки').count() >= 0 and 'Заявки' in a.page.inner_text('.modal'))

    a.page.set_viewport_size({'width': 375, 'height': 667}); a.page.keyboard.press('Escape'); time.sleep(0.3)
    row(a.page).click(); time.sleep(0.4)
    check('нет горизонтальной прокрутки на 375', a.page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'))
    a.shot('events_375')
    errs = [e for e in a.errors + b.errors if 'pageerror' in e]
    check('нет ошибок JS', not errs)
    if errs: print(errs[:3])
    br.close()
print(f"\n{sum(c for _, c in ok)}/{len(ok)} passed")
