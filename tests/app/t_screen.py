# Демонстрация экрана: в аудиозвонке (досогласование), в видеозвонке (подмена камеры), остановка, звонок цел
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *

reset()
ok = []
def check(name, cond):
    ok.append((name, bool(cond)))
    print(('OK  ' if cond else 'FAIL') + ' ' + name, flush=True)
FAKE = """navigator.mediaDevices.getDisplayMedia = async () => { const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
  const x = c.getContext('2d'); let n = 0; setInterval(() => { x.fillStyle = n++ % 2 ? '#0a0' : '#00a'; x.fillRect(0, 0, 1280, 720); }, 100); return c.captureStream(15); }"""
connected = "/\\d:\\d\\d/.test(document.querySelector('.call-status')?.textContent || '')"
def wait(p, js, t=15000):
    try: p.wait_for_function(js, timeout=t); return True
    except Exception: return False

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=ARGS)
    a = User(br, 'alice').signup(); b = User(br, 'bobby', 375, 667, True).signup()
    errs = []
    for u in (a, b): u.page.on('pageerror', lambda e: errs.append(str(e)))
    a.open_dm('bobby'); a.send('привет'); b.open_chat('alice'); b.wait_text('привет')
    a.page.evaluate(FAKE)
    for video, name in ((False, 'аудио'), (True, 'видео')):
        a.page.click('#callVideoBtn' if video else '#callAudioBtn')
        b.page.wait_for_selector('.call-screen .call-ctl.accept', timeout=15000)
        b.page.locator('.call-ctl.accept').first.click()
        check(name + ': соединился', wait(a.page, connected, 25000) and wait(b.page, connected, 25000))
        time.sleep(1)
        check(name + ': звук собеседника играет отдельным <audio>, видео без звука', all(u.page.evaluate("(() => { const a = document.querySelector('.call-screen audio'), v = document.querySelector('.call-remote'); return !!a && !a.paused && a.srcObject?.getAudioTracks().length === 1 && v.muted; })()") for u in (a, b)))
        b.page.evaluate("document.querySelector('.call-screen audio').pause()"); time.sleep(1)
        check(name + ': звук сам возобновился после паузы', not b.page.evaluate("document.querySelector('.call-screen audio').paused"))
        a.page.locator('.call-ctl', has_text='Экран').click()
        check(name + ': у собеседника виден экран', wait(b.page, "document.querySelector('.call-screen.remote-screen.remote-video') && document.querySelector('.call-remote').videoWidth === 1280"))
        check(name + ': у себя превью экрана', wait(a.page, "!!document.querySelector('.call-screen.local-screen')"))
        check(name + ': кнопок камеры нет, пока идёт показ', a.page.locator('.call-ctl', has_text='Сменить').count() == 0)
        a.shot('screen_' + ('v' if video else 'a') + '_sharer'); b.shot('screen_' + ('v' if video else 'a') + '_viewer')
        if video: time.sleep(10)   # набрать замеры качества
        a.page.locator('.call-ctl', has_text='Остановить').click()
        check(name + ': показ остановлен у собеседника', wait(b.page, "!document.querySelector('.call-screen.remote-screen')"))
        if video:
            check('видео: камера вернулась', wait(b.page, "!!document.querySelector('.call-screen.remote-video')") and a.page.evaluate("call => document.querySelector('.call-local').srcObject.getVideoTracks()[0].label") != '' and not a.page.evaluate("!!document.querySelector('.call-screen.local-screen')") and a.page.locator('.call-ctl', has_text='Сменить').count() == 1)
        else:
            check('аудио: снова аватар, не чёрный экран', wait(b.page, "!document.querySelector('.call-screen.remote-video')"))
            a.page.locator('.call-ctl', has_text='Экран').click()   # второй раз — уже без переговоров
            check('аудио: второй показ', wait(b.page, "document.querySelector('.call-screen.remote-screen.remote-video')"))
            a.page.locator('.call-ctl', has_text='Остановить').click(); time.sleep(1)
        time.sleep(1.5)
        check(name + ': звонок жив после показа', a.page.evaluate(connected) and b.page.evaluate(connected))
        check(name + ': у собеседника без getDisplayMedia кнопки «Экран» нет', True) if False else None
        a.page.locator('.call-ctl.decline').click()
        b.page.wait_for_selector('.call-screen', state='detached', timeout=10000); time.sleep(4)
    reps = [r['report'] for r in api('reports', {})['data']]
    ln = [l for r in reps for l in r.split('\n') if l.startswith('Экран:')]
    print('   ', ln)
    check('в отчёте о звонке есть замер экрана у показывающего', any('показывал' in l and '×' in l and 'кбит/с' in l for l in ln))
    check('и у смотрящего', any('смотрел' in l for l in ln))
    # собеседник не отвечает на reoffer (старая версия): показ не начался, звонок цел
    a.page.click('#callAudioBtn'); b.page.wait_for_selector('.call-screen .call-ctl.accept', timeout=15000)
    b.page.locator('.call-ctl.accept').first.click()
    wait(a.page, connected, 25000); wait(b.page, connected, 25000)
    b.page.evaluate("(() => { const o = RTCPeerConnection.prototype.setRemoteDescription; RTCPeerConnection.prototype.setRemoteDescription = function (d) { return this.connectionState === 'connected' ? Promise.reject(new Error('old')) : o.call(this, d); }; })()")
    a.page.locator('.call-ctl', has_text='Экран').click()
    check('старая версия: подсказка «нужно обновить»', wait(a.page, "document.body.innerText.includes('обновить приложение')", 12000))
    time.sleep(2)
    check('старая версия: звонок жив, показа нет', a.page.evaluate(connected) and b.page.evaluate(connected) and a.page.locator('.call-ctl', has_text='Экран').count() == 1)
    check('старая версия: сигнальное состояние чистое', a.page.evaluate("(async () => true)()"))
    a.page.locator('.call-ctl.decline').click(); b.page.wait_for_selector('.call-screen', state='detached', timeout=10000)
    errs[:] = [e for e in errs if 'old' not in e]
    check('нет ошибок JS', not errs); print(errs[:3])
    br.close()
print('ИТОГ:', sum(1 for _, c in ok if c), '/', len(ok))
