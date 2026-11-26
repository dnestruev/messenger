# Найденные баги (26.11): двойное нажатие, выход со всех устройств, пустой email, английские ошибки
import os, sys, time, json, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *
reset(); ok = []
def close_all(p):
    for _ in range(4):
        if p.locator('.modal').count() == 0: break
        p.keyboard.press('Escape'); time.sleep(0.25)
def check(name, cond):
    ok.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    # пустой email: запрос на вход не уходит, понятное сообщение
    g = User(br, 'guestx')
    sent = []
    g.page.on('request', lambda r: sent.append(r.url) if r.url.endswith('/api/login') else None)
    g.page.fill('#email', '   '); g.page.fill('#password', 'secret123'); g.page.evaluate("document.getElementById('email').removeAttribute('required')")
    g.page.evaluate("document.getElementById('authForm').requestSubmit ? document.getElementById('authForm').requestSubmit() : document.getElementById('authForm').submit()")
    time.sleep(0.8)
    check('пустой email: на сервер не ушло, «Впишите email»', not sent and 'Впишите email' in g.page.inner_text('#authMsg'))
    a = User(br, 'alice').signup()
    a.page.on('dialog', lambda d: d.accept())
    # двойное нажатие: создатель трижды жмёт «начислить» — уходит один запрос
    boss = User(br, 'boss').signup(); api('role', {'username': 'boss', 'role': 'creator'})
    a.page.locator('.fortune-pill').click(); a.page.wait_for_selector('.fortune .reel-tile')
    a.page.locator('.modal button', has_text='Докупить крутки').click(); a.page.wait_for_selector('.modal textarea')
    a.page.locator('.modal button', has_text='Отправить заявку').click(); time.sleep(0.5)
    check('короткое подтверждение доната — подсказка без запроса', 'от 5 символов' in a.page.inner_text('.modal'))
    a.page.fill('.modal textarea', 'донат 900 от alice'); a.page.locator('.modal button', has_text='Отправить заявку').click(); time.sleep(1.2)
    boss.page.reload(); boss.page.wait_for_selector('.chat-item'); time.sleep(0.8)
    close_all(boss.page); boss.page.click('#settingsBtn'); time.sleep(0.6)
    boss.page.locator('.section', has_text='Лимитированные статусы').locator('button', has_text='Открыть').click(); boss.page.wait_for_selector('.shop')
    boss.page.locator('.segmented button', has_text='Заявки').click(); boss.page.wait_for_selector('.order-card')
    calls = []
    def slow(r):
        if 'fortune_decide' in (r.request.post_data or ''): calls.append(1); time.sleep(0.6)
        r.continue_()
    boss.page.route(re.compile(r'/api/rpc\?'), slow)
    boss.page.locator('.modal button', has_text='Деньги пришли — начислить').evaluate("b => { b.click(); b.click(); b.click(); }")
    boss.page.wait_for_timeout(2500)
    print('calls', calls); check('тройное нажатие «начислить» — один запрос (было: несколько)', len(calls) == 1)
    a.page.keyboard.press('Escape'); time.sleep(0.3); a.page.keyboard.press('Escape'); time.sleep(0.3)
    # выход — только на этом устройстве
    a.page.keyboard.press('Escape'); time.sleep(0.3)
    a.page.click('#settingsBtn'); time.sleep(0.6)
    a.page.locator('.modal button', has_text='Выйти').first.click(); a.page.wait_for_timeout(1500)
    check('выход: scope=local (остальные устройства остаются в аккаунте)', a.page.evaluate('window.__signOutScope') == 'local')
    errs = [e for e in a.errors + g.errors + boss.errors if 'pageerror' in e]
    check('нет ошибок JS', not errs); print(errs[:3]) if errs else None
    br.close()
print(f"\n{sum(c for _, c in ok)}/{len(ok)} passed")
