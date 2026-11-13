# Приложение для iPhone: мост сайта с обёрткой (window.webkit.messageHandlers.native)
import os, sys, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

reset()
ok = []
def check(name, cond):
    ok.append((name, bool(cond)))
    print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)

FAKE = """
window.__native = []; window.__hid = false;
window.webkit = { messageHandlers: { native: { postMessage: (m) => window.__native.push(JSON.parse(JSON.stringify(m))) } } };
Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return window.__hid; } });
"""
def msgs(p, t=None): return [m for m in p.evaluate('window.__native') if t is None or m.get('t') == t]

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    plain = User(br, 'carol').signup()
    check('обычный сайт: класса native-app нет', not plain.page.evaluate("document.documentElement.classList.contains('native-app')"))

    a = User(br, 'alice', 375, 667, True)
    a.ctx.add_init_script(FAKE)
    a.page.reload(); a.signup()
    b = User(br, 'bobby').signup()
    time.sleep(1)
    dev = msgs(a.page, 'device')
    check('после входа приложение получило секрет и адрес центра', len(dev) >= 1 and dev[-1].get('secret', '').startswith('sec-') and dev[-1].get('api', '').startswith('http') and dev[-1].get('key'))
    check('класс native-app есть', a.page.evaluate("document.documentElement.classList.contains('native-app')"))

    a.page.reload(); a.page.wait_for_selector('.chat-item'); time.sleep(1)
    dev2 = msgs(a.page, 'device')
    check('после перезапуска секрет тот же (не плодим устройства)', dev2 and dev2[-1]['secret'] == dev[-1]['secret'])

    b.open_dm('alice'); b.send('первое'); time.sleep(1.5)
    check('страница видна — уведомления через приложение нет', not msgs(a.page, 'notify'))
    a.page.evaluate('window.__hid = true')
    b.send('секретный **текст**'); time.sleep(1.5)
    n = msgs(a.page, 'notify')
    check('страница скрыта — уведомление с текстом', len(n) == 1 and n[0]['body'] == 'секретный текст' and n[0]['title'] == 'bobby' and len(n[0]['conv']) == 36)
    a.page.evaluate('window.__hid = false')

    conv = n[0]['conv'] if n else ''
    a.page.evaluate('location.hash = ""'); time.sleep(0.3)
    a.page.evaluate(f'window.nativeOpenChat({json.dumps(conv)})'); time.sleep(1)
    check('нажали на уведомление — открылся чат', 'секретный' in a.page.inner_text('#messages'))
    a.page.evaluate('window.nativeOpenChat("<script>")')

    a.page.evaluate("document.querySelector('#settingsBtn').click()"); time.sleep(0.5)
    a.page.on('dialog', lambda d: d.accept())
    out = a.page.locator('.modal button', has_text='Выйти')
    if out.count(): out.first.click(); time.sleep(1.5)
    last = msgs(a.page, 'device')
    check('выход — приложение забыло секрет', last and last[-1].get('secret') is None)

    errs = [e for e in a.errors + plain.errors if 'pageerror' in e]
    check('нет ошибок JS', not errs)
    if errs: print(errs[:3])
    br.close()
print(f"\n{sum(c for _, c in ok)}/{len(ok)} passed")
