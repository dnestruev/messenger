import os
import sys, time
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
    b1 = User(br, 'bobby').signup('код боба 123')
    a.open_dm('bobby'); a.send('привет')
    b1.open_chat('alice'); b1.wait_text('привет')
    # второе устройство Боба
    b2 = User(br, 'bobby')
    b2.page.fill('#email', 'bobby@t.t'); b2.page.fill('#password', 'password1'); b2.page.click('#authBtn')
    b2.page.wait_for_selector('.modal input[type=password]')
    b2.page.fill('.modal input[type=password]', 'код боба 123'); b2.page.click('.modal .btn-primary')
    b2.page.wait_for_selector('.modal', state='detached', timeout=20000)
    b2.page.wait_for_selector('.chat-item')
    b2.open_chat('alice'); b2.wait_text('привет')
    check('второе устройство расшифровало переписку', True)

    # звонок: отвечаем на первом, второе должно замолчать
    a.page.click('#callAudioBtn')
    b1.page.wait_for_selector('.call-screen .call-ctl.accept', timeout=15000)
    b2.page.wait_for_selector('.call-screen .call-ctl.accept', timeout=15000)
    check('звонит на обоих устройствах', True)
    b1.page.locator('.call-ctl.accept').last.click()
    b2.page.wait_for_selector('.call-screen', state='detached', timeout=10000)
    check('второе устройство перестало звонить после ответа на первом', True)
    a.page.wait_for_function("/\\d:\\d\\d/.test(document.querySelector('.call-status')?.textContent || '')", timeout=20000)
    check('звонок соединился', True)
    time.sleep(2.5)
    a.page.locator('.call-ctl.decline').click()
    b1.page.wait_for_selector('.call-screen', state='detached', timeout=10000)
    check('завершение дошло', True)
    a.page.wait_for_function("[...document.querySelectorAll('.call-box small')].some(e => /Исходящий · 0:0[1-9]/.test(e.textContent))", timeout=10000)
    check('в чате итог звонка с длительностью', True)

    # отклонение: повторные offer не должны снова звонить
    a.page.click('#callVideoBtn')
    b1.page.wait_for_selector('.call-screen .call-ctl.decline', timeout=15000)
    b2.page.wait_for_selector('.call-screen .call-ctl.decline', timeout=15000)
    b1.page.locator('.call-ctl.decline').click()
    b2.page.wait_for_selector('.call-screen', state='detached', timeout=10000)
    a.page.wait_for_selector('.call-screen', state='detached', timeout=10000)
    time.sleep(4)
    check('после отклонения не звонит снова', b1.page.locator('.call-screen').count() == 0 and b2.page.locator('.call-screen').count() == 0)
    a.page.wait_for_function("[...document.querySelectorAll('.call-box b')].some(e => e.textContent.includes('отклонён'))", timeout=10000)
    check('итог «отклонён»', True)
    check('заголовок вкладки восстановлен', 'Входящий' not in b1.page.title())

    # голосовое
    a.page.click('#micBtn')
    a.page.wait_for_selector('#recBar:not([hidden])')
    time.sleep(1.6)
    a.page.click('#recSend')
    b1.page.wait_for_selector('.msg.voice', timeout=15000)
    check('голосовое дошло', True)
    # двойное нажатие на микрофон — одна запись
    a.page.evaluate("document.getElementById('micBtn').click(); document.getElementById('micBtn').click()")
    a.page.wait_for_selector('#recBar:not([hidden])')
    time.sleep(1.2)
    a.page.click('#recCancel')
    time.sleep(0.5)
    check('после отмены запись не идёт', a.page.locator('#recBar[hidden]').count() == 1)

    for u in (a, b1, b2):
        errs = [e for e in u.errors if 'ERR_' not in e]
        check(f'нет ошибок JS ({u.nick})', not errs)
        if errs: print('\n'.join(errs[:10]))
    br.close()
print('ИТОГ:', sum(1 for _, x in ok if x), '/', len(ok))
