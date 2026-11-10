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
    b.open_dm('alice')
    for i in range(130): b.page.fill('#text', f'м{i}'); b.page.press('#text', 'Enter')
    time.sleep(1)
    a.open_chat('bobby'); a.wait_text('м129')
    n = lambda: a.page.locator('#messages .msg').count()
    check(f'нарисовано окно, а не всё ({n()})', 75 <= n() <= 85)
    # новое сообщение дорисовывается, окно не съезжает
    b.send('свежее'); a.wait_text('свежее')
    check('новое дорисовано в конец', a.page.evaluate("[...document.querySelectorAll('#messages .msg')].pop().textContent.includes('свежее')"))
    check('после дорисовки старые не пропали', n() >= 81)
    # «Показать более ранние» — из памяти, без скачка
    a.page.evaluate("document.getElementById('messages').scrollTop = 0"); time.sleep(0.3)
    first = a.page.evaluate("document.querySelector('#messages .msg .msg-text').textContent")
    before = a.page.evaluate("""(() => { const t = %r; const el = [...document.querySelectorAll('#messages .msg .msg-text')].find(e => e.textContent === t);
      const r = el.getBoundingClientRect(), b = document.getElementById('messages').getBoundingClientRect(); return r.top - b.top; })()""" % first)
    a.page.click('.load-more'); time.sleep(0.5)
    still = a.page.evaluate("""(() => { const t = %r; const el = [...document.querySelectorAll('#messages .msg .msg-text')].find(e => e.textContent === t);
      const r = el.getBoundingClientRect(), b = document.getElementById('messages').getBoundingClientRect(); return r.top - b.top; })()""" % first)
    check(f'после «Показать более ранние» всё на месте (сдвиг {round(still - before)} px)', abs(still - before) < 3)
    check('показаны все 131', n() == 131)
    # ответ на старое сообщение — переход к нему, даже если оно было за окном
    a.open_chat('Избранное'); a.open_chat('bobby'); a.wait_text('свежее')
    a.page.evaluate("document.getElementById('messages').scrollTop = 0"); time.sleep(0.2)
    a.page.click('.load-more'); time.sleep(0.4)
    a.page.locator('.msg .msg-text', has_text='м3').first.scroll_into_view_if_needed(); a.page.locator('.msg .msg-text', has_text='м3').first.click(button='right')
    a.page.locator('.menu button', has_text='Ответить').click()
    a.send('ответ на старое')
    a.open_chat('Избранное'); a.open_chat('bobby'); a.wait_text('ответ на старое')
    check('м3 сейчас за окном', a.page.locator('.msg .msg-text', has_text='м3').count() == 0)
    a.page.locator('.msg-quote').last.click(); time.sleep(0.8)
    vis = a.page.evaluate("""(() => { const el = [...document.querySelectorAll('#messages .msg .msg-text')].find(e => e.textContent === 'м3');
      if (!el) return false; const r = el.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight; })()""")
    check('переход по цитате к старому сообщению', vis)
    # поиск находит то, что за окном
    a.open_chat('Избранное'); a.open_chat('bobby'); a.wait_text('ответ на старое')
    a.page.click('#searchBtn'); a.page.fill('#searchInput', 'м10'); time.sleep(0.6)
    a.page.press('#searchInput', 'Enter'); a.page.press('#searchInput', 'Enter'); time.sleep(0.8)
    check('поиск подсветил сообщение за окном', a.page.locator('.msg.search-cur').count() == 1)
    errs = [e for u in (a, b) for e in u.errors if 'ERR_' not in e]
    check('нет ошибок JS', not errs)
    if errs: print('\n'.join(errs[:10]))
    br.close()
print('ИТОГ:', sum(1 for _, x in ok if x), '/', len(ok))
