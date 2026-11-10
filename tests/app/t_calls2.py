# Звонки в неудобных условиях: адреса только из приглашения/ответа, поздний ответ,
# повторный вход тем же аккаунтом (переиспользование каналов), «печатает» после смены чатов.
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

reset()
ok = []
def check(name, cond):
    ok.append((name, bool(cond)))
    print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
NO_TRICKLE = "RTCPeerConnection.prototype.addIceCandidate = function () { window.__droppedIce = (window.__droppedIce || 0) + 1; return Promise.resolve(); };"

def connected(u, t=25000):
    u.page.wait_for_function("/\\d:\\d\\d/.test(document.querySelector('.call-status')?.textContent || '')", timeout=t)

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    a = User(br, 'alice').signup()
    b = User(br, 'bobby').signup()
    for u in (a, b): u.page.on('dialog', lambda d: d.accept())
    a.open_dm('bobby'); a.send('привет')
    b.open_chat('alice'); b.wait_text('привет')

    # 1. отдельные адреса теряются — звонок должен соединиться по адресам из приглашения/ответа
    for u in (a, b): u.page.evaluate(NO_TRICKLE)
    a.page.click('#callAudioBtn')
    b.page.wait_for_selector('.call-screen .call-ctl.accept', timeout=15000)
    b.page.locator('.call-ctl.accept').last.click()
    try: connected(a); check('соединился без отдельных адресов (только из SDP)', True)
    except Exception: check('соединился без отдельных адресов (только из SDP)', False)
    a.page.locator('.call-ctl.decline').click()
    b.page.wait_for_selector('.call-screen', state='detached', timeout=10000)
    time.sleep(1)

    # 2. ответ через 12 секунд
    a.page.click('#callAudioBtn')
    b.page.wait_for_selector('.call-screen .call-ctl.accept', timeout=15000)
    time.sleep(12)
    b.page.locator('.call-ctl.accept').last.click()
    try: connected(b); check('поздний ответ (через 12 с) соединился', True)
    except Exception: check('поздний ответ (через 12 с) соединился', False)
    b.page.locator('.call-ctl.decline').click()
    a.page.wait_for_selector('.call-screen', state='detached', timeout=10000)
    time.sleep(1)

    # 3. Боб вышел и сразу зашёл снова — входящие звонки должны приходить
    b.page.click('#settingsBtn')
    b.page.locator('.modal button', has_text='Выйти').last.click()
    b.page.wait_for_selector('#authBtn', timeout=10000)
    b.page.click('#tabLogin')
    b.page.fill('#email', 'bobby@t.t'); b.page.fill('#password', 'password1'); b.page.click('#authBtn')
    b.page.wait_for_selector('.modal input[type=password]')
    b.page.fill('.modal input[type=password]', 'секретный код 1'); b.page.click('.modal .btn-primary')
    b.page.wait_for_selector('.modal', state='detached', timeout=20000)
    b.page.wait_for_selector('.chat-item'); time.sleep(1.5)
    a.page.click('#callVideoBtn')
    try:
        b.page.wait_for_selector('.call-screen .call-ctl.accept', timeout=15000)
        check('после выхода и входа звонок приходит', True)
        b.page.locator('.call-ctl.accept').first.click()
        connected(a); check('и соединяется (видео)', True)
        a.page.locator('.call-ctl.decline').click()
    except Exception: check('после выхода и входа звонок приходит', False)
    time.sleep(1.5)

    # 4. «печатает» после быстрого переключения чатов туда-обратно
    b.open_chat('alice'); b.open_chat('Избранное'); b.open_chat('alice'); time.sleep(1.5)
    a.page.click('#text'); a.page.keyboard.type('печатаю', delay=60)
    try:
        b.page.wait_for_function("document.querySelector('#chatStatus').textContent.includes('печатает')", timeout=6000)
        check('«печатает» работает после переключения чатов', True)
    except Exception: check('«печатает» работает после переключения чатов', False)

    rep = debug()['db']['call_reports']
    check(f'отчёты о звонках записаны ({len(rep)})', len(rep) >= 4)
    if rep: print('  пример отчёта:\n   ' + rep[-1]['report'].replace('\n', '\n   ')[:900])
    for u in (a, b):
        errs = [e for e in u.errors if 'ERR_' not in e]
        check(f'нет ошибок JS ({u.nick})', not errs)
        if errs: print('\n'.join(errs[:8]))
    br.close()
print('ИТОГ:', sum(1 for _, x in ok if x), '/', len(ok))
