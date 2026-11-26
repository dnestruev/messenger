# Вкладки: Чаты · Фортуна · Магазин · Темы · Админка — страницы вместо окон
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *
reset(); ok = []
def check(name, cond):
    ok.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
def tabs(p): return p.eval_on_selector_all('.tab', 'els => els.map(e => e.dataset.tab)')
with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    boss = User(br, 'boss').signup(); api('role', {'username': 'boss', 'role': 'creator'})
    m = User(br, 'alice', 375, 667, True).signup()
    for u in (boss, m): u.page.on('dialog', lambda d: d.accept())
    boss.page.reload(); boss.page.wait_for_selector('.chat-item'); time.sleep(1)
    m.page.reload(); m.page.wait_for_selector('.chat-item'); time.sleep(1)
    check('у обычного: Чаты, Фортуна, Магазин, Темы', tabs(m.page) == ['chats', 'fortune', 'shop', 'themes'])
    check('у создателя есть Админка', tabs(boss.page)[-1] == 'admin')
    check('на Фортуне счётчик бесплатных круток', m.page.inner_text('.tab[data-tab=fortune] .tab-count') == '3')
    p = m.page
    p.click('.tab[data-tab=themes]'); p.wait_for_selector('.theme-card')
    check('Темы: 7 карточек с превью, страница вместо окна', p.locator('.theme-card').count() == 7 and p.locator('.overlay').count() == 0 and p.locator('#pageView .page-title').inner_text() == 'Темы')
    check('вкладки видны на странице (телефон)', p.locator('#tabbar').is_visible())
    p.locator('.theme-card', has_text='Dot').click(); time.sleep(0.5)
    check('выбор темы Dot применился', p.evaluate("document.documentElement.dataset.style") == 'dot')
    p.locator('.theme-card', has_text='Бумага').click(); time.sleep(0.5)
    check('Бумага без Плюса не включилась', p.evaluate("document.documentElement.dataset.style") == 'dot')
    p.locator('.theme-card', has_text='Обычная').click(); time.sleep(0.3)
    p.click('.tab[data-tab=fortune]'); p.wait_for_selector('.fortune .reel-tile')
    check('Фортуна открылась страницей', 'Фортуна' in p.inner_text('#pageView .page-title') and p.locator('.overlay').count() == 0)
    p.locator('#pageView button', has_text='Докупить крутки').click(); time.sleep(0.5)
    check('вложенный экран со стрелкой «назад»', p.locator('.page-back:visible').count() == 1 and 'Купить крутки' in p.inner_text('.page-title'))
    p.locator('.page-back').click(); p.wait_for_selector('.fortune .reel-tile')
    check('«назад» вернул в начало вкладки', p.locator('.page-back:visible').count() == 0)
    p.click('.tab[data-tab=shop]'); p.wait_for_selector('.shop .shop-card')
    check('Магазин страницей, без «Назад в настройки»', p.locator('.to-settings:visible').count() == 0)
    p.click('#tabbar .tab[data-tab=chats]'); time.sleep(0.5)
    check('назад в Чаты — список на месте', p.locator('#chatList').is_visible() and p.locator('#pageView').inner_text() == '')
    p.click('#settingsBtn'); time.sleep(0.8)
    check('настройки — страница-меню без профиля', p.locator('#pageView .set-row').count() >= 8 and p.locator('#pageView input[placeholder^="Имя"]').count() == 0)
    p.locator('.set-row b', has_text='Уведомления').click(); time.sleep(0.5)
    check('раздел настроек со стрелкой назад', p.locator('.page-back').count() == 1 and 'Уведомления' in p.inner_text('.page-title'))
    p.locator('.page-back').click(); time.sleep(0.4)
    p.locator('.set-me').click(); time.sleep(0.8)
    check('профиль отдельно: имя, ник, фото', p.locator('.profile-hero').count() == 1 and p.locator('#pageView input[placeholder^="Имя"]').count() == 1)
    p.locator('.page-back').click(); time.sleep(0.4); p.locator('.page-back').click(); time.sleep(0.4)
    check('из настроек назад — в чаты', p.evaluate("document.body.dataset.tab") == 'chats' and p.locator('#chatList').is_visible())
    b = boss.page
    b.click('.tab[data-tab=admin]'); b.wait_for_selector('.hub-item')
    check('Админка: События, Заявки, Люди, Тесты, Статистика, Журнал', b.locator('.hub-item').count() == 6)
    b.locator('.hub-item b', has_text='Люди').click(); b.wait_for_selector('.admin-user, .admin')
    check('Люди внутри вкладки, со стрелкой назад', b.locator('.page-back').count() == 1 and b.locator('.overlay').count() == 0)
    b.locator('.page-back').click(); b.wait_for_selector('.hub-item')
    b.locator('.hub-item b', has_text='Заявки').click(); time.sleep(1)
    check('Заявки — магазин на вкладке «Заявки»', b.locator('.segmented button.on', has_text='Заявки').count() == 1)
    # открыть чат с любой вкладки — переключает на Чаты
    b.click('.tab[data-tab=themes]'); b.wait_for_selector('.theme-card')
    b.locator('.chat-item', has_text='Избранное').click(); time.sleep(0.8)
    check('клик по чату на ПК возвращает во вкладку Чаты', b.evaluate("document.body.dataset.tab") == 'chats' and b.locator('#messages').is_visible())
    for w, hh in ((320, 568), (375, 667), (667, 375), (1440, 900)):
        b.set_viewport_size({'width': w, 'height': hh}); time.sleep(0.3)
        if b.locator('#backBtn').is_visible(): b.click('#backBtn'); time.sleep(0.4)
        b.click('.tab[data-tab=themes]') if b.locator('.tab[data-tab=themes]').is_visible() else None
        time.sleep(0.6)
        check(f'{w}x{hh}: без горизонтальной прокрутки, вкладки на экране', b.evaluate('document.documentElement.scrollWidth <= innerWidth + 1') and b.locator('#tabbar').is_visible())
        b.screenshot(path=f'/home/claude/test/shots/tabs_themes_{w}x{hh}.png')
    errs = [e for e in boss.errors + m.errors if 'pageerror' in e]
    check('нет ошибок JS', not errs); print(errs[:3]) if errs else None
    br.close()
print(f"\n{sum(c for _, c in ok)}/{len(ok)} passed")
