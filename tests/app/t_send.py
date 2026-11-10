# Отправка без ожидания сервера: сообщение видно сразу с часиками, потом — галочка, без дублей;
# при ошибке пузырь исчезает, текст возвращается в поле.
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
    b = User(br, 'bobby').signup()
    a.open_dm('bobby'); a.send('первое')
    b.open_chat('alice'); b.wait_text('первое')
    api('slow', {'ms': 2500})
    p = a.page
    p.fill('#text', 'медленное'); t0 = time.time(); p.press('#text', 'Enter')
    p.wait_for_selector('.msg.mine.pending', timeout=1500)
    check('сообщение видно сразу (до ответа сервера)', time.time() - t0 < 1.5)
    check('у него часики', p.locator('.msg.pending .ticks.pending').count() == 1)
    p.wait_for_selector('.msg.mine.pending', state='detached', timeout=8000)
    time.sleep(1)
    n = p.evaluate("[...document.querySelectorAll('.msg.mine .msg-text')].filter(e => e.textContent.includes('медленное')).length")
    check('после ответа — одно сообщение, без дубля', n == 1)
    check('стоит галочка', p.locator('.msg.mine').last.locator('.ticks:not(.pending)').count() == 1)
    b.wait_text('медленное')
    check('собеседник получил', True)
    api('slow', {'fail': True})
    p.fill('#text', 'не уйдёт'); p.press('#text', 'Enter'); time.sleep(1.5)
    n = p.evaluate("[...document.querySelectorAll('.msg .msg-text')].filter(e => e.textContent.includes('не уйдёт')).length")
    check('ошибка: пузырь убран', n == 0)
    check('ошибка: текст вернулся в поле', p.input_value('#text') == 'не уйдёт')
    api('slow', {})
    p.press('#text', 'Enter'); a.wait_text('не уйдёт') if hasattr(a, 'wait_text') else time.sleep(2)
    time.sleep(1)
    check('повтор после ошибки ушёл один раз', p.evaluate("[...document.querySelectorAll('.msg.mine .msg-text')].filter(e => e.textContent.includes('не уйдёт')).length") == 1)
    for u in (a, b):
        errs = [e for e in u.errors if 'ERR_' not in e]
        check(f'нет ошибок JS ({u.nick})', not errs)
        if errs: print('\n'.join(errs[:5]))
    br.close()
print('ИТОГ:', sum(1 for _, x in ok if x), '/', len(ok))
