# Свои тесты: загрузка .docx → разбор вопросов, вариантов, ключа, задачи и решения → правка → сохранение
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *
reset(); ok = []
D = os.path.dirname(os.path.abspath(__file__))
def check(name, cond):
    ok.append((name, bool(cond))); print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    boss = User(br, 'boss').signup(); api('role', {'username': 'boss', 'role': 'creator'})
    bp = boss.page; bp.on('dialog', lambda d: d.accept())
    bp.reload(); bp.wait_for_selector('.chat-item'); time.sleep(0.8)
    def open_tests():
        tab(bp, 'admin'); bp.locator('.hub-item b', has_text='Тесты для команды').click(); time.sleep(0.8)
    open_tests()
    bp.locator('#pageView button', has_text='Загрузить тест').click(); time.sleep(0.5)
    bp.set_input_files('#pageView input[type=file]', D + '/exam_files/v1.docx'); time.sleep(1.5)
    t = bp.inner_text('#pageView')
    check('v1: 10 вопросов, ключ найден у всех', bp.locator('.exam-q.edit').count() == 10 and 'у всех отмечен ответ' in t)
    check('v1: ответы как в ключе (1 — int, 8 — 3)', 'int' in bp.locator('.exam-q.edit').nth(0).locator('.exam-opt.right').inner_text() and bp.locator('.exam-q.edit').nth(7).locator('.exam-opt.right .exam-opt-text').inner_text() == '3')
    check('v1: задача и решение разобраны', 'Калькулятор чётных чисел' in bp.input_value('#pageView textarea[placeholder^="Практическое"]') and 'total += i' in bp.input_value('#pageView textarea[placeholder^="Эталонное"]'))
    check('v1: отступы в решении сохранились', '    if i % 2 == 0:' in bp.input_value('#pageView textarea[placeholder^="Эталонное"]'))
    check('v1: название', 'Тест по основам Python' in bp.input_value('#pageView input[placeholder="Название теста"]'))
    boss.shot('exam_import_1440')
    bp.locator('#pageView button', has_text='Сохранить тест').click(); time.sleep(1)
    check('сохранён и виден в списке', 'Тест по основам Python и практическое задание' in bp.inner_text('#pageView'))
    # v2 без ключа — надо отметить ответы
    bp.locator('#pageView button', has_text='Загрузить тест').click(); time.sleep(0.5)
    bp.set_input_files('#pageView input[type=file]', D + '/exam_files/v2.docx'); time.sleep(1.5)
    check('v2: 10 вопросов, без ключа — подсказка', bp.locator('.exam-q.edit').count() == 10 and 'без ответа: 10' in bp.inner_text('#pageView'))
    bp.locator('#pageView button', has_text='Сохранить тест').click(); time.sleep(0.5)
    check('без ответов не сохранить', 'не отмечен правильный ответ' in bp.inner_text('#pageView'))
    for i, j in enumerate([2, 1, 3, 1, 2, 1, 3, 1, 2, 1]): bp.locator('.exam-q.edit').nth(i).locator('.exam-opt').nth(j).click()
    bp.locator('.exam-q.edit').nth(9).locator('.icon-btn[title="Удалить вопрос"]').click(); time.sleep(0.3)
    check('удалили вопрос — осталось 9', bp.locator('.exam-q.edit').count() == 9 and 'у всех отмечен' in bp.inner_text('#pageView'))
    bp.fill('#pageView input[placeholder="Название теста"]', 'Python v2')
    bp.locator('#pageView button', has_text='Сохранить тест').click(); time.sleep(1)
    check('v2 сохранён', 'Python v2' in bp.inner_text('#pageView') and '9 вопр.' in bp.inner_text('#pageView'))
    check('свой тест можно выбрать для запуска', bp.locator('#pageView select option', has_text='Python v2').count() == 1)
    # вставка текстом
    bp.locator('#pageView button', has_text='Загрузить тест').click(); time.sleep(0.5)
    bp.fill('#pageView textarea', 'Мини тест\n1. 2+2?\nа) 3\nб) 4\n2. Столица Франции?\nA) Париж\nB) Рим\nОтветы:\n1. б)\n2. A)')
    bp.locator('#pageView button', has_text='Разобрать текст').click(); time.sleep(0.6)
    check('текст: 2 вопроса, ответы из ключа (рус. и лат. буквы)', bp.locator('.exam-q.edit').count() == 2 and bp.locator('.exam-opt.right').count() == 2 and 'Мини тест' in bp.input_value('#pageView input[placeholder="Название теста"]'))
    # любые форматы: тот же тест — Word 97, OpenOffice, RTF, PDF, текст (UTF-8 и 1251), HTML
    for f in ['v1.doc', 'v1.odt', 'v1.rtf', 'v1.pdf', 'v1.txt', 'v1_cp1251.txt', 'v1.html']:
        open_tests(); bp.locator('#pageView button', has_text='Загрузить тест').click(); time.sleep(0.5)
        bp.set_input_files('#pageView input[type=file]', D + '/exam_files/' + f); time.sleep(2.5)
        n = bp.locator('.exam-q.edit').count(); keyed = 'у всех отмечен' in bp.inner_text('#pageView')
        sol = bp.locator('#pageView textarea[placeholder^="Эталонное"]')
        has_sol = sol.count() and 'total += i' in sol.input_value()
        check(f'{f}: 10 вопросов, ключ, решение', n == 10 and keyed and has_sol); print('   ', f, n, keyed, has_sol) if not (n == 10 and keyed and has_sol) else None
    open_tests(); bp.locator('#pageView button', has_text='Загрузить тест').click(); time.sleep(0.5)
    bp.set_input_files('#pageView input[type=file]', D + '/exam_files/pic.png'); time.sleep(1)
    check('картинка — понятный отказ', 'Картинку прочитать не получится' in bp.inner_text('#pageView'))
    errs = [e for e in boss.errors if 'pageerror' in e]
    check('нет ошибок JS', not errs); print(errs[:3]) if errs else None
    br.close()
print(f"\n{sum(c for _, c in ok)}/{len(ok)} passed")
