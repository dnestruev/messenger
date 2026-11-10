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
    b = User(br, 'bobby').signup()
    c = User(br, 'carol').signup()
    a.page.click('#newGroupBtn')
    a.page.fill('.modal input >> nth=0', 'Клуб')
    a.page.fill('.modal input >> nth=1', 'bobby')
    a.page.click('.modal .btn-primary')
    a.page.wait_for_function("document.querySelector('#chatTitle')?.textContent.includes('Клуб')")
    a.send('раз')
    b.open_chat('Клуб'); b.wait_text('раз')
    check('у Боба 2 участника', '2 участника' in b.page.inner_text('#chatStatus'))
    a.page.click('#chatInfo')
    a.page.fill('.modal input[placeholder="Ник"]', 'carol')
    a.page.locator('.modal button[title="Добавить"]').click()
    b.page.wait_for_function("document.querySelector('#chatStatus').textContent.includes('3 участника')", timeout=10000)
    check('у Боба шапка обновилась до 3 участников без перезагрузки', True)
    time.sleep(1.5); a.page.keyboard.press('Escape')
    c.open_chat('Клуб'); c.wait_text('раз', timeout=15000)
    check('Кэрол видит старые сообщения группы', True)

    # подпись к фото: берётся из поля и поле очищается сразу
    a.page.fill('#text', 'смотри фото')
    a.page.set_input_files('#fileInput', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'p.png'))
    a.page.wait_for_function("document.querySelector('#text').value === ''", timeout=3000)
    b.page.wait_for_function("[...document.querySelectorAll('.msg.photo .msg-text')].some(e => e.textContent.includes('смотри фото'))", timeout=15000)
    check('фото с подписью', True)

    # стикер в режиме правки не трогает поле правки
    a.send('опечатка')
    a.page.locator('.msg.mine', has_text='опечатка').click(button='right')
    a.page.locator('.menu button', has_text='Изменить').click()
    a.page.click('#stickerBtn')
    a.page.locator('.sticker-tile').first.click()
    time.sleep(1)
    check('режим правки сохранился после стикера', a.page.locator('#composeBar:not([hidden])').count() == 1 and a.page.input_value('#text') == 'опечатка')
    a.page.keyboard.press('Escape')

    # счётчик непрочитанных в заголовке вкладки
    b.page.click('#backBtn') if b.page.locator('#backBtn').is_visible() else None
    b.open_chat('Избранное')
    a.send('новое для боба')
    b.page.wait_for_function("document.title.startsWith('(1)')", timeout=10000)
    check('в заголовке вкладки (1)', True)

    for u in (a, b, c):
        errs = [e for e in u.errors if 'ERR_' not in e]
        check(f'нет ошибок JS ({u.nick})', not errs)
        if errs: print('\n'.join(errs[:10]))
    br.close()
print('ИТОГ:', sum(1 for _, x in ok if x), '/', len(ok))
