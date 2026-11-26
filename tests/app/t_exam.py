# Тест для команды (update-30): запуск → уведомление и отсчёт → прохождение → проверка с ответами
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *
reset(); ok = []
def check(name, cond):
    ok.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    boss = User(br, 'boss').signup(); api('role', {'username': 'boss', 'role': 'creator'})
    t = User(br, 'tester1', 375, 667, True).signup(); api('role', {'username': 'tester1', 'role': 'tester'})
    s = User(br, 'senior1').signup(); api('mod', {'username': 'senior1', 'level': 'senior'})
    n = User(br, 'normal').signup()
    for u in (boss, t, s, n): u.page.on('dialog', lambda d: d.accept())
    bp = boss.page
    bp.reload(); bp.wait_for_selector('.chat-item'); time.sleep(0.8)
    tab(bp, 'admin'); bp.locator('.hub-item b', has_text='Тесты для команды').click(); time.sleep(0.8)
    check('создатель: экран запуска теста', 'Запустить тест' in bp.inner_text('#pageView') and 'Основы Python' in bp.inner_text('#pageView'))
    bp.locator('#pageView button', has_text='Запустить').last.click(); time.sleep(1)
    check('назначено двоим: тестер и старший', bp.locator('.exam-row').count() == 2 and 'не начал' in bp.inner_text('#pageView'))
    # тестер получает уведомление
    tp = t.page
    tp.reload(); tp.wait_for_selector('.chat-item'); time.sleep(2)
    check('уведомление «Тебе назначен тест»', tp.locator('.exam-notice').count() == 1 and 'Основы Python' in tp.inner_text('.exam-notice'))
    tp.locator('.exam-notice button', has_text='Позже').click(); time.sleep(0.3)
    c1 = tp.inner_text('.exam-pill .exam-clock'); time.sleep(1.3); c2 = tp.inner_text('.exam-pill .exam-clock')
    check('плашка с обратным отсчётом идёт', c1 != c2 and 'начать в течение' in tp.inner_text('.exam-pill'))
    n.page.reload(); n.page.wait_for_selector('.chat-item'); time.sleep(1.5)
    check('обычному человеку теста нет', n.page.locator('.exam-pill, .exam-notice').count() == 0)
    tp.locator('.exam-pill').click(); time.sleep(0.5)
    tp.locator('.modal button', has_text='Начать').click(); time.sleep(1)
    check('тест открылся: 3 вопроса, таймер, поле для кода', tp.locator('.exam-q').count() == 3 and tp.locator('.exam-code').count() == 1 and ':' in tp.inner_text('.exam-bar .exam-clock'))
    tp.locator('.exam-q').nth(0).locator('.exam-opt').nth(2).click()
    tp.locator('.exam-q').nth(1).locator('.exam-opt').nth(0).click()
    tp.locator('.exam-q').nth(2).locator('.exam-opt').nth(3).click()
    tp.fill('.exam-code', 'n = int(input())\nprint(n)'); time.sleep(2)
    check('ответы сохранились сами', 'Сохранено' in tp.inner_text('.exam-bar'))
    t.shot('exam_taking_375')
    tp.locator('.modal button', has_text='Сдать').click(); time.sleep(1.2)
    check('сдал — окно закрылось, плашка ушла', tp.locator('.exam-q').count() == 0 and tp.locator('.exam-pill').count() == 0)
    # проверка создателем
    bp.locator('.page-back').click(); time.sleep(0.5); bp.locator('.hub-item b', has_text='Тесты для команды').click(); time.sleep(0.8)
    bp.locator('#pageView .hub-item').first.click(); time.sleep(0.8)
    check('в результатах: tester1 2/3, сдал на проверку', '2/3' in bp.inner_text('#pageView') and 'сдал на проверку' in bp.inner_text('#pageView'))
    bp.locator('.exam-row', has_text='tester1').click(); time.sleep(0.8)
    txt = bp.inner_text('#pageView')
    check('видны ответы: правильный и ошибочный', bp.locator('.exam-opt.right').count() == 3 and bp.locator('.exam-opt.wrong').count() == 1 and '✗ его ответ' in txt)
    check('виден его код и эталон', 'print(n)' in txt and bp.locator('.exam-solution').count() == 1)
    boss.shot('exam_review_1440')
    bp.locator('#pageView button', has_text='Сдал ✓').click(); time.sleep(0.8)
    check('tester1 — СДАЛ', 'СДАЛ ✓' in bp.inner_text('#pageView'))
    bp.locator('.exam-row', has_text='senior1').click(); time.sleep(0.6)
    check('senior1 не начинал', 'Не начинал' in bp.inner_text('#pageView'))
    bp.locator('#pageView button', has_text='снять роль').click(); time.sleep(1)
    check('senior1 — ПРОВАЛИЛ, права сняты', 'ПРОВАЛИЛ' in bp.inner_text('#pageView') and not any(m['user_id'] for m in debug()['db'].get('moderators', []) if m.get('level') == 'senior'))
    errs = [e for e in boss.errors + t.errors + s.errors + n.errors if 'pageerror' in e]
    check('нет ошибок JS', not errs); print(errs[:3]) if errs else None
    br.close()
print(f"\n{sum(c for _, c in ok)}/{len(ok)} passed")
