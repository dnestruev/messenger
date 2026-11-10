import os
import sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

reset()
with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    a = User(br, 'alice').signup()
    b = User(br, 'bobby').signup()
    a.open_dm('bobby')
    for t in ['Привет! Как дела?', 'Длинное сообщение ' * 12, '> цитата\n- пункт один\n- пункт два\n`код` и ||спойлер||']:
        a.page.fill('#text', t); a.page.press('#text', 'Enter'); time.sleep(0.3)
    b.open_chat('alice'); b.wait_text('Как дела')
    b.send('Норм 👍')
    sizes = [(320, 568, True), (375, 667, True), (667, 375, True), (1440, 900, False)]
    for w, h, mob in sizes:
        u = User(br, 'alice', w, h, mob)
        u.page.click('#tabLogin')
        u.shot(f'auth_{w}x{h}')
        u.page.fill('#email', 'alice@t.t'); u.page.fill('#password', 'password1'); u.page.click('#authBtn')
        u.page.wait_for_selector('.modal input[type=password]')
        u.page.fill('.modal input[type=password]', 'секретный код 1'); u.page.click('.modal .btn-primary')
        u.page.wait_for_selector('.modal', state='detached', timeout=20000)
        u.page.wait_for_selector('.chat-item')
        u.shot(f'list_{w}x{h}')
        u.open_chat('bobby'); u.wait_text('Норм')
        time.sleep(0.6)
        u.shot(f'chat_{w}x{h}')
        over = u.page.evaluate("document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth")
        print(f'{w}x{h} горизонтальная прокрутка:', over)
        u.ctx.close()
    # «Забыли пароль?»
    u = User(br, 'x', 375, 667, True)
    u.page.click('#forgotBtn')
    print('без email:', u.page.inner_text('#authMsg'))
    u.page.fill('#email', 'alice@t.t'); u.page.click('#forgotBtn')
    print('с email:', u.page.inner_text('#authMsg'), u.page.evaluate('window.__resetAsked'))
    u.page.click('#tabSignup')
    print('на регистрации кнопка скрыта:', u.page.locator('#forgotBtn').is_hidden())
    br.close()
