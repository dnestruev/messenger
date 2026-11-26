# iPhone 7 (Safari iOS 15): createImageBitmap падает «An error occured reading the Blob argument» — фото всё равно уходит
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

reset()
ok = []
def check(name, cond):
    ok.append((name, bool(cond)))
    print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
BREAK = "window.createImageBitmap = () => Promise.reject(new DOMException('An error occured reading the Blob argument to createImageBitmap', 'InvalidStateError'));"
png = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'p.png')

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    a = User(br, 'alice', 375, 667, True); a.ctx.add_init_script(BREAK); a.page.reload(); a.signup()
    b = User(br, 'bobby').signup()
    b.open_dm('alice'); b.send('привет'); a.open_chat('bobby'); a.wait_text('привет')
    a.page.set_input_files('#fileInput', png)
    try:
        b.page.wait_for_function("[...document.querySelectorAll('img.msg-img')].some(i => i.src.startsWith('blob:') && i.naturalWidth > 0)", timeout=15000); got = True
    except Exception: got = False
    check('фото дошло, хотя createImageBitmap сломан', got)
    check('ошибки «Фото не отправилось» нет', 'не отправилось' not in a.page.inner_text('body').lower())
    # битый файл — понятное сообщение, а не английская ошибка
    a.page.set_input_files('#fileInput', {'name': 'bad.png', 'mimeType': 'image/png', 'buffer': b'not an image'})
    time.sleep(2)
    t = a.page.inner_text('body')
    check('битая картинка — понятное сообщение по-русски', 'Не получилось открыть эту картинку' in t and 'createImageBitmap' not in t)
    errs = [e for e in a.errors + b.errors if 'pageerror' in e]
    check('нет ошибок JS', not errs)
    if errs: print(errs[:3])
    br.close()
print(f"\n{sum(c for _, c in ok)}/{len(ok)} passed")
