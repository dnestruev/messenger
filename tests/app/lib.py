import json, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:8765/'
ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']

def reset():
    urllib.request.urlopen(urllib.request.Request(BASE + 'api/reset', data=b'{}', method='POST'))

def debug():
    return json.load(urllib.request.urlopen(urllib.request.Request(BASE + 'api/debug', data=b'{}', method='POST')))

class User:
    def __init__(self, browser, nick, w=1280, h=800, mobile=False):
        self.nick = nick
        self.ctx = browser.new_context(viewport={'width': w, 'height': h}, has_touch=mobile, is_mobile=mobile,
                                       permissions=['microphone', 'camera'])
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append('pageerror: ' + str(e)))
        self.page.on('console', lambda m: self.errors.append('console: ' + m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'fonts.g' not in m.text else None)
        self.page.goto(BASE)

    def signup(self, code='секретный код 1'):
        p = self.page
        p.click('#tabSignup')
        p.fill('#username', self.nick)
        p.fill('#email', self.nick + '@t.t')
        p.fill('#password', 'password1')
        p.click('#authBtn')
        p.wait_for_selector('.modal input[type=password]')
        ins = p.locator('.modal input[type=password]')
        ins.nth(0).fill(code); ins.nth(1).fill(code)
        p.click('.modal .btn-primary')
        p.wait_for_selector('.modal', state='detached', timeout=20000)
        p.wait_for_selector('.chat-item')
        return self

    def open_dm(self, nick):
        p = self.page
        p.fill('#findInput', nick)
        p.press('#findInput', 'Enter')
        p.wait_for_function(f"document.querySelector('#chatTitle')?.textContent.includes('{nick}')", timeout=10000)

    def open_chat(self, title):
        self.page.locator('.chat-item', has=self.page.locator('.chat-item-name', has_text=title)).first.click()
        self.page.wait_for_function(f"document.querySelector('#chatTitle')?.textContent.includes({json.dumps(title)})")

    def send(self, text):
        p = self.page
        shown = text.replace('**', '')
        p.fill('#text', text)
        p.press('#text', 'Enter')
        p.wait_for_function(f"[...document.querySelectorAll('.msg.mine .msg-text')].some(e => e.textContent.includes({json.dumps(shown)}))", timeout=10000)

    def wait_text(self, text, timeout=10000):
        self.page.wait_for_function(f"[...document.querySelectorAll('.msg .msg-text')].some(e => e.textContent.includes({json.dumps(text)}))", timeout=timeout)

    def texts(self):
        return self.page.eval_on_selector_all('#messages .msg .msg-text', 'els => els.map(e => e.textContent)')

    def shot(self, name):
        self.page.screenshot(path=f'/home/claude/test/shots/{name}.png')
