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
    check('Избранное есть у обоих', a.page.locator('.chat-item', has_text='Избранное').count() == 1)

    a.open_dm('bobby')
    a.send('привет, **боб**')
    b.page.wait_for_selector('.chat-item.unread')
    check('у Боба непрочитанное', b.page.locator('.chat-item.unread').count() == 1)
    b.open_chat('alice')
    b.wait_text('привет, боб')
    check('жирный текст отрисован', b.page.locator('.msg-text strong', has_text='боб').count() == 1)
    # галочки: у Алисы должно стать ✓✓ без перерисовки ленты
    a.page.evaluate("window.__mark = document.querySelector('#messages .msg.mine'); window.__mark.dataset.keep = '1'")
    a.page.wait_for_function("document.querySelector('.msg.mine .ticks')?.classList.contains('read')", timeout=10000)
    check('прочитано ✓✓', True)
    check('лента не перерисована при прочтении', a.page.evaluate("document.querySelector('#messages .msg.mine')?.dataset.keep === '1'"))

    # ответ
    b.page.locator('.msg', has_text='привет').first.click(button='right')
    b.page.locator('.menu button', has_text='Ответить').click()
    b.send('и тебе привет')
    a.wait_text('и тебе привет')
    check('цитата в ответе', a.page.locator('.msg-quote', has_text='привет').count() >= 1)

    # двойной Enter не шлёт дважды
    a.page.fill('#text', 'один раз')
    a.page.press('#text', 'Enter'); a.page.press('#text', 'Enter')
    time.sleep(1.5)
    check('двойной Enter — одно сообщение', a.texts().count('один раз') == 1)

    # правка
    a.page.locator('.msg.mine', has_text='один раз').click(button='right')
    a.page.locator('.menu button', has_text='Изменить').click()
    a.page.fill('#text', 'один раз (исправлено)')
    a.page.press('#text', 'Enter')
    b.wait_text('один раз (исправлено)')
    check('правка дошла', True)
    check('пометка «изменено»', b.page.locator('.msg', has_text='исправлено').locator('.msg-meta', has_text='изменено').count() == 1)

    # реакция двойным кликом
    b.page.locator('.msg', has_text='исправлено').locator('.msg-text').dblclick()
    a.page.wait_for_selector('.msg .rx', timeout=10000)
    check('реакция ❤️ дошла', a.page.locator('.msg .rx-e', has_text='❤️').count() == 1)

    # удаление
    a.page.on('dialog', lambda d: d.accept())
    b.page.on('dialog', lambda d: d.accept())
    a.page.locator('.msg.mine', has_text='исправлено').click(button='right')
    a.page.locator('.menu button', has_text='Удалить').click()
    b.page.wait_for_function("![...document.querySelectorAll('.msg-text')].some(e => e.textContent.includes('исправлено'))", timeout=10000)
    check('удаление дошло', True)

    # фото без узлов -> хранилище центра; удаление убирает файл
    import base64, os
    png = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'p.png')
    a.page.set_input_files('#fileInput', png)
    b.page.wait_for_function("[...document.querySelectorAll('img.msg-img')].some(i => i.src.startsWith('blob:'))", timeout=15000)
    check('фото дошло и расшифровалось', True)
    files_before = len(debug()['files'])
    a.page.locator('.msg.mine.photo').last.click(button='right')
    a.page.locator('.menu button', has_text='Удалить').click()
    time.sleep(1.5)
    check('файл фото удалён из хранилища', len(debug()['files']) == files_before - 1)

    # группа
    c = User(br, 'carol').signup()
    c.page.on('dialog', lambda d: d.accept())
    a.page.click('#newGroupBtn')
    a.page.fill('.modal input >> nth=0', 'Тусовка')
    a.page.fill('.modal input >> nth=1', 'bobby carol nobody')
    a.page.click('.modal .btn-primary')
    a.page.wait_for_function("document.querySelector('#chatTitle')?.textContent.includes('Тусовка')")
    a.page.wait_for_selector('.toast:has-text("nobody")', timeout=5000)
    check('сообщение «Не нашли @nobody»', True)
    a.send('всем привет')
    c.page.wait_for_selector('.chat-item:has-text("Тусовка")', timeout=10000)
    c.open_chat('Тусовка')
    c.wait_text('всем привет', timeout=15000)
    check('Кэрол читает группу', True)
    # Кэрол выходит — ключ меняется, Алиса всё равно может писать
    c.page.click('#chatInfo')
    c.page.locator('.modal button', has_text='Выйти из группы').click()
    c.page.wait_for_selector('.modal', state='detached')
    time.sleep(1)
    check('у Кэрол группа пропала', c.page.locator('.chat-item', has_text='Тусовка').count() == 0)
    a.send('после выхода')
    b.open_chat('Тусовка')
    b.wait_text('после выхода', timeout=15000)
    check('после смены ключа Боб читает', True)
    check('шапка: 2 участника', '2 участника' in a.page.inner_text('#chatStatus'))

    # личный чат удалили — у второго он пропадает
    b.open_chat('alice')
    b.page.click('#chatInfo')
    b.page.locator('.modal button', has_text='Удалить чат').click()
    a.page.wait_for_function("![...document.querySelectorAll('.chat-item')].some(e => e.textContent.includes('bobby'))", timeout=10000)
    check('удалённый личный чат пропал у Алисы', True)

    # свой ник в поиске — Избранное
    a.page.fill('#findInput', 'alice'); a.page.press('#findInput', 'Enter')
    a.page.wait_for_function("document.querySelector('#chatTitle')?.textContent.includes('Избранное')")
    check('свой ник открывает Избранное', True)

    for u in (a, b, c):
        errs = [e for e in u.errors if 'ERR_' not in e and 'favicon' not in e]
        check(f'нет ошибок JS у {u.nick}', not errs)
        if errs: print('\n'.join(errs[:10]))
    br.close()

print('ИТОГ:', sum(1 for _, x in ok if x), '/', len(ok))
