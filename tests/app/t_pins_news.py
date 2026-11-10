# Закреплённые чаты (меню, порядок перетаскиванием, синхронизация между устройствами) и канал «Новости»
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

reset()
ok = []
def relog(u):
    u.page.reload(); u.page.wait_for_selector('.chat-item, .modal input[type=password]', timeout=20000)
    if u.page.locator('.modal input[type=password]').count():
        u.page.fill('.modal input[type=password]', 'секретный код 1'); u.page.click('.modal .btn-primary')
        u.page.wait_for_selector('.modal', state='detached', timeout=20000)
    u.page.wait_for_selector('.chat-item')
def check(name, cond):
    ok.append((name, bool(cond)))
    print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
def names(u):
    return u.page.evaluate("[...document.querySelectorAll('#chatList .chat-item:not(.news-item) .chat-item-name')].map(e => e.textContent.replace(/[^a-zа-я0-9]/gi,'').replace(/Создатель|Тестер/g,''))")

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    a = User(br, 'alice').signup()
    others = [User(br, n).signup() for n in ('bobby', 'carol', 'danny')]
    api('role', {'username': 'alice', 'role': 'creator'})
    for o in others: a.open_dm(o.nick); a.send('привет ' + o.nick)
    time.sleep(1)
    p = a.page
    p.click('#backBtn') if p.locator('#backBtn').is_visible() else None
    # закрепить carol и bobby через правую кнопку
    for n in ('carol', 'bobby'):
        p.locator('.chat-item', has=p.locator('.chat-item-name', has_text=n)).click(button='right')
        p.locator('.menu button', has_text='Закрепить').click(); time.sleep(0.6)
    order = names(a)
    check('закреплённые наверху в порядке закрепления (после Избранного)', order[1:3] == ['carol', 'bobby'])
    check('у закреплённых значок булавки', p.locator('.chat-item.pinned .pin-mark').count() == 2)
    # новое сообщение от danny не поднимает его выше закреплённых
    others[2].open_chat('alice'); others[2].send('я выше?'); time.sleep(1.5)
    check('новое сообщение не обгоняет закреплённые', names(a)[1:4] == ['carol', 'bobby', 'danny'])
    # перетаскивание мышью: bobby наверх
    it = p.locator('.chat-item.pinned', has=p.locator('.chat-item-name', has_text='bobby'))
    box = it.bounding_box()
    p.mouse.move(box['x'] + 40, box['y'] + box['height'] / 2); p.mouse.down(); time.sleep(0.35)
    for k in range(1, 8): p.mouse.move(box['x'] + 40, box['y'] + box['height'] / 2 - k * box['height'] / 6); time.sleep(0.03)
    p.mouse.up(); time.sleep(1)
    check('перетащили: bobby выше carol', names(a)[1:3] == ['bobby', 'carol'])
    a.shot('pins')
    # после перезагрузки порядок тот же (хранится на сервере)
    relog(a); time.sleep(0.5)
    check('после перезагрузки порядок сохранился', names(a)[1:3] == ['bobby', 'carol'])
    # открепить
    p.locator('.chat-item', has=p.locator('.chat-item-name', has_text='carol')).click(button='right')
    p.locator('.menu button', has_text='Открепить').click(); time.sleep(0.6)
    check('открепили carol', p.locator('.chat-item.pinned').count() == 1)

    # ---------- Новости ----------
    check('строка «Новости» в списке', p.locator('.news-item').count() == 1)
    p.locator('.news-item').click(); p.wait_for_selector('.news-screen')
    check('пустой канал', 'Новостей пока нет' in p.inner_text('.news-feed'))
    p.fill('#newsText', '**Обнова!** звонки починили 🎉'); p.keyboard.press('Enter'); time.sleep(0.8)
    check('создатель опубликовал', p.locator('.news-post').count() == 1 and 'Обнова!' in p.inner_text('.news-post b, .news-post strong'))
    b = others[0]
    bp = b.page
    bp.wait_for_function("document.querySelector('.news-item .unread-dot')", timeout=8000)
    check('у bobby новость пришла сразу и горит непрочитанной', True)
    bp.locator('.news-item').click(); bp.wait_for_selector('.news-post')
    check('bobby не может писать', bp.locator('#newsText').count() == 0)
    bp.locator('.news-chip.add').click(); bp.locator('.menu-react button').first.click(); time.sleep(0.8)
    check('bobby поставил реакцию', bp.locator('.news-chip.on').count() == 1)
    p.wait_for_function("document.querySelector('.news-chip small')?.textContent === '1'", timeout=8000)
    check('создатель видит реакцию сразу', True)
    b.shot('news_reader')
    bp.locator('.news-chip.on').click(); time.sleep(0.8)
    check('реакцию сняли', bp.locator('.news-chip:not(.add)').count() == 0)
    bp.locator('.news-screen .icon-btn').first.click(); time.sleep(0.5)
    check('закрыли — непрочитанного нет', bp.locator('.news-item .unread-dot').count() == 0)
    # правка и удаление создателем
    p.locator('.news-post').click(button='right'); p.locator('.menu button', has_text='Изменить').click()
    p.fill('#newsText', 'исправлено'); p.keyboard.press('Enter'); time.sleep(0.8)
    check('правка: изменено', 'изменено' in p.inner_text('.news-post'))
    a.shot('news_creator')
    p.on('dialog', lambda d: d.accept())
    p.locator('.news-post').click(button='right'); p.locator('.menu button', has_text='Удалить').click(); time.sleep(1)
    check('удалено у создателя', p.locator('.news-post').count() == 0)
    bp.locator('.news-item').click(); time.sleep(0.6)
    check('удалено у читателя', bp.locator('.news-post').count() == 0)
    for u in [a] + others:
        errs = [e for e in u.errors if 'ERR_' not in e]
        check(f'нет ошибок JS ({u.nick})', not errs)
        if errs: print('\n'.join(errs[:5]))
    br.close()
print('ИТОГ:', sum(1 for _, x in ok if x), '/', len(ok))
