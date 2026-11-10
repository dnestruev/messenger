# «Мои стикеры» не пропадают: копия в «Избранном» → видны на втором устройстве, после очистки памяти браузера,
# удаление — везде. Сами копии в ленте «Избранного» не видны.
import os, sys, time, base64
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42mP8z8Dwn4EIwDiqAa8C/2EAqgKxBgAx/w8DQwUDAwMDAQBhbAQfQn2bVQAAAABJRU5ErkJggg==')
reset()
ok = []
def check(name, cond):
    ok.append((name, bool(cond)))
    print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
def login(u, code='секретный код 1'):
    p = u.page
    p.fill('#email', u.nick + '@t.t'); p.fill('#password', 'password1'); p.click('#authBtn')
    p.wait_for_selector('.modal input[type=password]', timeout=20000)
    p.fill('.modal input[type=password]', code); p.click('.modal .btn-primary')
    p.wait_for_selector('.modal', state='detached', timeout=20000); p.wait_for_selector('.chat-item')
def my_count(u):
    if u.page.locator('#stickerBtn').is_hidden(): u.open_chat('bobby')
    u.page.click('#stickerBtn') if u.page.locator('#stickerPanel').is_hidden() else None
    u.page.locator('.sticker-panel button', has_text='Мои').first.click(); time.sleep(0.6)
    return u.page.locator('.sticker-tile:not(.sticker-add) img').count()

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    a = User(br, 'alice').signup()
    b = User(br, 'bobby').signup()
    a.open_dm('bobby'); a.send('привет')
    a.page.on('dialog', lambda d: d.accept())
    from PIL import Image as _I
    _I.new('RGBA', (64, 64), (255, 80, 120, 255)).save('/tmp/st.png')
    a.page.click('#stickerBtn'); a.page.locator('.sticker-panel button', has_text='Мои').first.click()
    a.page.set_input_files('.sticker-panel input[type=file]', '/tmp/st.png'); time.sleep(2)
    check('стикер добавлен на первом устройстве', a.page.locator('.sticker-tile:not(.sticker-add) img').count() == 1)
    # второе устройство того же человека
    a2 = User(br, 'alice'); login(a2)
    time.sleep(5)
    check('на втором устройстве стикер появился сам', my_count(a2) == 1)
    # «очистили память браузера» — после входа стикер вернётся
    a2.page.evaluate("indexedDB.databases ? 0 : 0")
    a2.page.evaluate("(async () => { const db = await new Promise(r => { const q = indexedDB.open('messenger-keys', 1); q.onsuccess = () => r(q.result); }); const names = [...db.objectStoreNames]; const tx = db.transaction(names, 'readwrite'); for (const n of names) { const s = tx.objectStore(n); const k = await new Promise(r => { const q = s.getAllKeys(); q.onsuccess = () => r(q.result); }); for (const key of k) if (String(key) === 'my-stickers') s.delete(key); } })()")
    a2.page.reload(); a2.page.wait_for_selector('.chat-item, .modal input[type=password]', timeout=20000)
    if a2.page.locator('.modal input[type=password]').count():
        a2.page.fill('.modal input[type=password]', 'секретный код 1'); a2.page.click('.modal .btn-primary'); a2.page.wait_for_selector('.modal', state='detached')
    time.sleep(5)
    check('после очистки памяти стикер вернулся', my_count(a2) == 1)
    # в «Избранном» копий не видно
    a2.page.keyboard.press('Escape')
    a2.open_chat('Избранное'); time.sleep(0.8)
    check('в ленте «Избранного» копии стикеров не видны', a2.page.locator('.msg').count() == 0)
    # удаление на втором — пропадает на первом
    a2.page.click('#stickerBtn'); a2.page.locator('.sticker-panel button', has_text='Мои').first.click(); time.sleep(0.5)
    a2.page.on('dialog', lambda d: d.accept())
    a2.page.locator('.sticker-tile:not(.sticker-add)').first.click(button='right'); time.sleep(1.5)
    check('удалили на втором', a2.page.locator('.sticker-tile:not(.sticker-add) img').count() == 0)
    a.page.click('#stickerBtn'); time.sleep(0.3)
    check('пропал и на первом', my_count(a) == 0 or (time.sleep(2) or my_count(a) == 0))
    # быстро добавить три стикера подряд, пока идёт сверка (было: сверка затирала только что добавленные)
    a.page.keyboard.press('Escape'); a.open_chat('bobby')
    a.page.click('#stickerBtn') if a.page.locator('#stickerPanel').is_hidden() else None
    a.page.locator('.sticker-panel button', has_text='Мои').first.click()
    for k, col in enumerate([(10, 200, 10, 255), (10, 10, 200, 255), (200, 200, 10, 255)]):
        _I.new('RGBA', (64, 64), col).save(f'/tmp/st{k}.png')
        a.page.set_input_files('.sticker-panel input[type=file]', f'/tmp/st{k}.png'); time.sleep(0.15)
    time.sleep(4)
    check('три быстрых стикера на месте', my_count(a) == 3)
    a.page.reload(); a.page.wait_for_selector('.chat-item, .modal input[type=password]', timeout=20000)
    if a.page.locator('.modal input[type=password]').count():
        a.page.fill('.modal input[type=password]', 'секретный код 1'); a.page.click('.modal .btn-primary'); a.page.wait_for_selector('.modal', state='detached')
    time.sleep(5)
    check('после перезагрузки все три остались', my_count(a) == 3)
    a2.page.reload(); a2.page.wait_for_selector('.chat-item, .modal input[type=password]', timeout=20000)
    if a2.page.locator('.modal input[type=password]').count():
        a2.page.fill('.modal input[type=password]', 'секретный код 1'); a2.page.click('.modal .btn-primary'); a2.page.wait_for_selector('.modal', state='detached')
    time.sleep(5)
    check('и на втором устройстве три', my_count(a2) == 3)
    for u in (a, a2, b):
        errs = [e for e in u.errors if 'ERR_' not in e]
        check(f'нет ошибок JS ({u.nick})', not errs)
        if errs: print('\n'.join(errs[:5]))
    br.close()
print('ИТОГ:', sum(1 for _, x in ok if x), '/', len(ok))
