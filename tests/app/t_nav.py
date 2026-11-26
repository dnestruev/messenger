# Навигация: «назад» возвращает туда, откуда пришёл; вкладки и настройки помнят место; после перезапуска — там же
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *
reset(); ok = []
def check(name, cond):
    ok.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
def title(p): return p.inner_text('#pageView .page-title') if p.locator('#pageView .page-title').count() else ''
def relog(u):
    u.page.reload(); u.page.wait_for_selector('.chat-item, .modal input[type=password]', state='attached', timeout=20000)
    if u.page.locator('.modal input[type=password]').count():
        u.page.fill('.modal input[type=password]', 'секретный код 1'); u.page.click('.modal .btn-primary')
        u.page.wait_for_selector('.modal input[type=password]', state='detached', timeout=20000)
    time.sleep(2)
with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    boss = User(br, 'boss', 375, 667, True, restore=True).signup(); api('role', {'username': 'boss', 'role': 'creator'})
    p = boss.page; p.on('dialog', lambda d: d.accept())
    p.reload(); p.wait_for_selector('.chat-item'); time.sleep(1)
    settings_page(p, 'Оформление'); time.sleep(0.5)
    check('из настроек в Темы — есть стрелка назад', title(p) == 'Темы' and p.locator('.page-back:visible').count() == 1)
    p.locator('.page-back').click(); time.sleep(0.5)
    check('назад из Тем — в настройки, не в чаты', title(p) == 'Настройки')
    p.locator('.set-me').click(); time.sleep(0.6); p.locator('.page-back').click(); time.sleep(0.5)
    check('профиль → назад → настройки', title(p) == 'Настройки')
    p.locator('.set-row b', has_text='Админка').click(); time.sleep(0.7)
    check('из настроек в Админку — назад в настройки', p.locator('.page-back:visible').count() == 1)
    p.locator('.page-back').click(); time.sleep(0.5)
    check('… вернулись в настройки', title(p) == 'Настройки')
    p.locator('.set-row b', has_text='Уведомления').click(); time.sleep(0.5)
    p.locator('.tab[data-tab=chats]').click(); time.sleep(0.4)
    p.click('#settingsBtn'); time.sleep(0.6)
    check('ушёл в чаты и вернулся — снова «Уведомления»', 'Уведомления' in title(p))
    p.locator('.page-back').click(); time.sleep(0.4)
    p.evaluate("document.getElementById('pageView').scrollTop = 300"); time.sleep(0.6)
    sc = p.evaluate("document.getElementById('pageView').scrollTop")
    p.locator('.tab[data-tab=shop]').click(); time.sleep(0.8); p.locator('.tab[data-tab=chats]').click(); time.sleep(0.3)
    p.click('#settingsBtn'); time.sleep(0.6)
    check(f'прокрутка настроек сохранилась ({sc})', title(p) == 'Настройки' and abs(p.evaluate("document.getElementById('pageView').scrollTop") - sc) < 3)
    p.locator('.tab[data-tab=themes]').click(); time.sleep(0.6)
    check('Темы из вкладок — без стрелки назад', p.locator('.page-back:visible').count() == 0)
    # перезапуск
    settings_page(p, 'Конфиденциальность'); time.sleep(0.6)
    relog(boss)
    check('после перезапуска — снова «Конфиденциальность»', 'Конфиденциальность' in title(p))
    p.locator('.page-back').click(); time.sleep(0.4)
    check('и назад — в меню настроек', title(p) == 'Настройки')
    for w in (320, 375):
        p.set_viewport_size({'width': w, 'height': 640}); time.sleep(0.3)
        for row in [None, 'Премиум', 'Партнёрство', 'Шифрование', 'Сеть партнёров', 'Аккаунт']:
            settings_page(p, row); time.sleep(0.4)
            if p.evaluate('document.documentElement.scrollWidth > innerWidth + 1 || document.getElementById("pageView").scrollWidth > innerWidth + 1'):
                check(f'{w}: «{row or "меню"}» шире экрана', False)
    check('ни один раздел настроек не шире экрана', True)
    # имя в профиле: шапка профиля и шапка настроек сразу новые
    profile_page(p); p.fill('#pageView input[placeholder^="Имя"]', 'Селёдка Луник')
    check('шапка профиля меняется при вводе', p.inner_text('.profile-hero .profile-name') == 'Селёдка Луник')
    p.locator('#pageView .btn-primary', has_text='Сохранить').click(); time.sleep(0.8)
    p.locator('.page-back').click(); time.sleep(0.6)
    check('в шапке настроек новое имя', 'Селёдка Луник' in p.inner_text('.set-me'))
    errs = [e for e in boss.errors if 'pageerror' in e]
    check('нет ошибок JS', not errs); print(errs[:3]) if errs else None
    br.close()
print(f"\n{sum(c for _, c in ok)}/{len(ok)} passed")
