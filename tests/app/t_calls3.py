# Звонок, когда сервер выдал TURN: два сервера с одинаковым адресом и разными логинами (как у партнёров).
# Было: клиент дописывал к адресу «?n=0», Chrome отказывался создавать соединение — звонки с Android не шли вовсе.
import os, sys, time
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
    for u in (a, b):
        u.page.on('dialog', lambda d: d.accept())
        u.page.evaluate("localStorage.setItem('mock-turn', '1')")
        u.page.reload(); u.page.wait_for_selector('.chat-item', timeout=20000)
    a.open_dm('bobby'); a.send('привет')
    b.open_chat('alice'); b.wait_text('привет')
    time.sleep(1)
    for caller, callee, name in ((a, b, 'компьютер → телефон'), (b, a, 'телефон → компьютер')):
        caller.page.click('#callAudioBtn')
        callee.page.wait_for_selector('.call-screen .call-ctl.accept', timeout=15000)
        callee.page.locator('.call-ctl.accept').last.click()
        try:
            caller.page.wait_for_function("/\\d:\\d\\d/.test(document.querySelector('.call-status')?.textContent || '')", timeout=25000)
            check('с TURN соединился: ' + name, True)
        except Exception: check('с TURN соединился: ' + name, False)
        caller.page.locator('.call-ctl.decline').click()
        callee.page.wait_for_selector('.call-screen', state='detached', timeout=10000)
        time.sleep(1.5)
    reps = debug()['db']['call_reports']
    check('в отчётах нет ошибки создания соединения', not any('not a valid' in r.get('report', '') for r in reps))
    check('в отчётах серверы TURN', any('Серверы: TURN' in r.get('report', '') for r in reps))
    for u in (a, b):
        errs = [e for e in u.errors if 'ERR_' not in e]
        check(f'нет ошибок JS ({u.nick})', not errs)
        if errs: print('\n'.join(errs[:5]))
    br.close()
print('ИТОГ:', sum(1 for _, x in ok if x), '/', len(ok))
