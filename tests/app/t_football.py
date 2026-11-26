# Уникальный значок «Футбольный мастер»: виден у ника, карточка, подтверждение сервером
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *
reset(); ok = []
def check(name, cond):
    ok.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    s = User(br, 'sp_89').signup(); b = User(br, 'bobby').signup()
    api('grant', {'username': 'sp_89', 'kind': 'football'})
    b.page.reload(); b.page.wait_for_selector('.chat-item')
    b.open_dm('sp_89'); b.send('го в футбол'); time.sleep(1)
    check('значок у ника в шапке чата', b.page.locator('.chat-header .role.football, header .role.football').count() >= 1)
    b.page.locator('.role.football').first.click(); time.sleep(1.5)
    t = b.page.inner_text('body')
    check('карточка: название и «единственный»', 'Футбольный мастер' in t and 'Единственный в мире' in t)
    check('подтверждено сервером', 'единственный такой значок' in t)
    check('иконка мяча отрисована', b.page.evaluate("!!document.querySelector('.role.football use[href=\"#i-ball\"], .role.football use[*|href=\"#i-ball\"]')"))
    b.page.keyboard.press('Escape'); time.sleep(0.3)
    b.page.locator('.role.football').first.screenshot(path='/home/claude/test/shots/football_badge.png')
    errs = [e for e in b.errors + s.errors if 'pageerror' in e]
    check('нет ошибок JS', not errs); print(errs[:2]) if errs else None
    br.close()
print(f"\n{sum(c for _, c in ok)}/{len(ok)} passed")
