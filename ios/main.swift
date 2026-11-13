// Мессенджер для iPhone (ставится через TrollStore).
// Внутри — живой сайт (патчи прилетают сразу). Своё у приложения только:
// работа в фоне, уведомления, разрешения камеры/микрофона.
import UIKit
import WebKit
import AVFoundation
import UserNotifications

let SITE = URL(string: "https://dnestruev.github.io/messenger/?app=ios")!
let SITE_HOST = "dnestruev.github.io"
let POLL_SECONDS: TimeInterval = 20

// ---------- Хранилище: секрет устройства от сайта ----------
enum Store {
  static var secret: String? {
    get { UserDefaults.standard.string(forKey: "secret") }
    set { UserDefaults.standard.set(newValue, forKey: "secret") }
  }
  static var api: String? {
    get { UserDefaults.standard.string(forKey: "api") }
    set { UserDefaults.standard.set(newValue, forKey: "api") }
  }
  static var key: String? {
    get { UserDefaults.standard.string(forKey: "key") }
    set { UserDefaults.standard.set(newValue, forKey: "key") }
  }
}

// ---------- Фон: беззвучный звук не даёт iOS усыпить приложение ----------
final class KeepAlive {
  static let shared = KeepAlive()
  private var player: AVAudioPlayer?

  private func silentWav() -> Data {
    let rate = 8000, seconds = 2, samples = rate * seconds
    var d = Data()
    func u32(_ v: Int) { var x = UInt32(v).littleEndian; d.append(Data(bytes: &x, count: 4)) }
    func u16(_ v: Int) { var x = UInt16(v).littleEndian; d.append(Data(bytes: &x, count: 2)) }
    d.append("RIFF".data(using: .ascii)!); u32(36 + samples * 2)
    d.append("WAVEfmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
    d.append("data".data(using: .ascii)!); u32(samples * 2)
    d.append(Data(count: samples * 2))
    return d
  }

  func start() {
    let s = AVAudioSession.sharedInstance()
    try? s.setCategory(.playback, mode: .default, options: [.mixWithOthers])
    try? s.setActive(true)
    if player == nil { player = try? AVAudioPlayer(data: silentWav()); player?.numberOfLoops = -1; player?.volume = 0.01 }
    player?.play()
  }
  func stop() { player?.stop() }
}

// ---------- Опрос сервера: «есть новые сообщения?» ----------
final class Poller {
  static let shared = Poller()
  private var timer: Timer?
  private var busy = false

  func start() {
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: POLL_SECONDS, repeats: true) { _ in self.poll() }
    poll()
  }
  func stop() { timer?.invalidate(); timer = nil }

  func poll() {
    guard !busy, let secret = Store.secret, let api = Store.api, let key = Store.key,
          let url = URL(string: api + "/rest/v1/rpc/app_poll") else { return }
    busy = true
    var r = URLRequest(url: url, timeoutInterval: 15)
    r.httpMethod = "POST"
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.setValue(key, forHTTPHeaderField: "apikey")
    r.httpBody = try? JSONSerialization.data(withJSONObject: ["p_secret": secret])
    URLSession.shared.dataTask(with: r) { data, _, _ in
      defer { self.busy = false }
      guard let data = data, let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
      for row in rows {
        guard let conv = row["conv"] as? String else { continue }
        let nick = (row["nick"] as? String).map { "@" + $0 } ?? "Мессенджер"
        let n = row["n"] as? Int ?? 1
        Notify.show(id: "c-" + conv, title: nick, body: n > 1 ? "Новых сообщений: \(n)" : "Новое сообщение", thread: conv)
      }
    }.resume()
  }
}

enum Notify {
  static func show(id: String, title: String, body: String, thread: String?) {
    let c = UNMutableNotificationContent()
    c.title = title; c.body = body; c.sound = .default
    if let t = thread { c.threadIdentifier = t; c.userInfo = ["conv": t] }
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
  }
}

// ---------- Экран с сайтом ----------
final class WebVC: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
  var web: WKWebView!

  override func loadView() {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .default()
    cfg.allowsInlineMediaPlayback = true
    cfg.mediaTypesRequiringUserActionForPlayback = []
    let ucc = WKUserContentController()
    ucc.add(self, name: "native")
    ucc.addUserScript(WKUserScript(source: "window.NATIVE_APP = 'ios-1';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    cfg.userContentController = ucc
    web = WKWebView(frame: .zero, configuration: cfg)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsBackForwardNavigationGestures = false
    web.scrollView.contentInsetAdjustmentBehavior = .never
    web.isOpaque = false
    web.backgroundColor = .black
    view = web
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    web.load(URLRequest(url: SITE))
  }

  func open(conv: String) {
    let js = "window.nativeOpenChat && window.nativeOpenChat(" + jsString(conv) + ");"
    web.evaluateJavaScript(js, completionHandler: nil)
  }

  private func jsString(_ s: String) -> String {
    let d = try? JSONSerialization.data(withJSONObject: [s])
    let a = d.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
    return String(a.dropFirst().dropLast())
  }

  // сообщения от сайта
  func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let b = m.body as? [String: Any], let t = b["t"] as? String else { return }
    switch t {
    case "device":
      Store.secret = b["secret"] as? String
      Store.api = b["api"] as? String
      Store.key = b["key"] as? String
    case "notify":
      let id = (b["conv"] as? String).map { "c-" + $0 } ?? UUID().uuidString
      Notify.show(id: id, title: b["title"] as? String ?? "Мессенджер", body: b["body"] as? String ?? "", thread: b["conv"] as? String)
    case "badge":
      UIApplication.shared.applicationIconBadgeNumber = b["n"] as? Int ?? 0
    default: break
    }
  }

  // ссылки наружу — в Safari
  func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if let u = a.request.url, let host = u.host, a.targetFrame?.isMainFrame != false,
       host != SITE_HOST, !host.hasSuffix(".supabase.co"), u.scheme == "https" || u.scheme == "http" {
      UIApplication.shared.open(u); decisionHandler(.cancel); return
    }
    decisionHandler(.allow)
  }
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
    if let u = a.request.url { UIApplication.shared.open(u) }
    return nil
  }
  // камера и микрофон для звонков (iOS 15+)
  @available(iOS 15.0, *)
  func webView(_ w: WKWebView, requestMediaCapturePermissionFor o: WKSecurityOrigin, initiatedByFrame f: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    decisionHandler(o.host == SITE_HOST ? .grant : .prompt)
  }
  // окна alert/confirm/prompt сайта
  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = UIAlertController(title: nil, message: m, preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
    present(a, animated: true)
  }
  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = UIAlertController(title: nil, message: m, preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(false) })
    a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
    present(a, animated: true)
  }
  func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText d: String?, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let a = UIAlertController(title: nil, message: p, preferredStyle: .alert)
    a.addTextField { $0.text = d }
    a.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(nil) })
    a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
    present(a, animated: true)
  }
  // страница упала (нехватка памяти) — перезагрузить
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }

  override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
}

// ---------- Приложение ----------
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  var window: UIWindow?
  let vc = WebVC()

  func application(_ app: UIApplication, didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)
    window?.rootViewController = vc
    window?.makeKeyAndVisible()
    let nc = UNUserNotificationCenter.current()
    nc.delegate = self
    nc.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { _ in
      if UIApplication.shared.applicationState != .active { KeepAlive.shared.start() }
    }
    return true
  }

  func applicationDidEnterBackground(_ app: UIApplication) {
    KeepAlive.shared.start()
    Poller.shared.start()
  }
  func applicationWillEnterForeground(_ app: UIApplication) {
    Poller.shared.stop()
    KeepAlive.shared.stop()
    UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    app.applicationIconBadgeNumber = 0
  }

  // пока приложение открыто — уведомления не показываем (сайт сам всё видит)
  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void) {
    h(UIApplication.shared.applicationState == .active ? [] : [.banner, .sound])
  }
  // нажали на уведомление — открыть чат
  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler h: @escaping () -> Void) {
    if let conv = r.notification.request.content.userInfo["conv"] as? String { vc.open(conv: conv) }
    h()
  }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
