# Ава не должна навсегда превращаться в букву, если картинка один раз не загрузилась (сеть моргнула, приложение было в фоне)
import os, sys, time, base64
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

reset()
ok = []
def check(name, cond):
    ok.append((name, bool(cond)))
    print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    a = User(br, 'alice', 375, 667, True).signup()
    api('avatar', {'username': 'alice', 'path': 'x/a.png'})
    fails = {'n': 3}
    def handle(route):
        if fails['n'] > 0:
            fails['n'] -= 1; route.abort()
        else:
            route.fulfill(status=200, content_type='image/png', body=PNG)
    a.page.route('**/storage/v1/object/public/**', handle)
    a.page.reload(); a.page.wait_for_selector('.chat-item'); time.sleep(0.5)
    a.page.click('#settingsBtn'); a.page.wait_for_selector('.modal .profile-head')
    time.sleep(0.5)
    def photo_ok():
        return a.page.evaluate("[...document.querySelectorAll('.modal .profile-head .avatar-img')].some(i => i.complete && i.naturalWidth > 0)")
    check('сначала не загрузилась — пока буква', not photo_ok())
    deadline = time.time() + 25
    while time.time() < deadline and not photo_ok(): time.sleep(0.5)
    check('ава сама появилась после повторов', photo_ok())
    check('класс has-photo вернулся', a.page.evaluate("!!document.querySelector('.modal .profile-head .avatar.has-photo')"))
    errs = [e for e in a.errors if 'pageerror' in e]
    check('нет ошибок JS', not errs)
    br.close()
print(f"\n{sum(c for _, c in ok)}/{len(ok)} passed")
