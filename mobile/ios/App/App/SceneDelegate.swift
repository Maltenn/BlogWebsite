import UIKit
import AuthenticationServices
import Capacitor

// The window's root. Capacitor's own view controller (CAPBridgeViewController, the web view) is a CHILD of a small shell
// view controller, so the page can be laid out inside the safe area while the shell paints what is behind the bars:
//   - the band behind the status bar is the first colour of the site's header gradient (.ms-header, #1c3f94), so the
//     header seems to run up under the clock without the page ever being drawn there (no env(safe-area-inset-*) in app.css);
//   - the band behind the home indicator is the footer's colour (.os-foot, #eef4ff);
//   - the keyboard pushes the web view up through keyboardLayoutGuide (the page then sees a shorter viewport, as in Safari).
// The splash is a native overlay on exactly the web view's frame: two bitmaps rendered from the real index.html + app.css
// (mobile/scripts/make-splash.mjs), the header block on top and the footer block at the bottom, white between, which is
// what the page's first frame is. native.js asks for it to go once that first frame is on screen.

private enum Brand {
    static let statusBand = UIColor(red: 0x1c / 255.0, green: 0x3f / 255.0, blue: 0x94 / 255.0, alpha: 1)   // #1c3f94
    static let homeBand = UIColor(red: 0xee / 255.0, green: 0xf4 / 255.0, blue: 0xff / 255.0, alpha: 1)       // #eef4ff
    // the CSS widths (points) make-splash.mjs renders; an unlisted device uses the widest one that fits
    static let splashWidths = [320, 375, 390, 393, 402, 414, 428, 430, 440, 744, 768, 810, 820, 834]
}

final class ShellViewController: UIViewController {
    static let hideSplash = Notification.Name("OurSpaceHideSplash")
    static let setTabs = Notification.Name("OurSpaceSetTabs")          // object: TabSpec?, from ShellPlugin.setTabs
    static let tabTapped = Notification.Name("OurSpaceTabTapped")      // object: TabSpec.Item, to ShellPlugin

    private let web = AppBridgeViewController()
    private let tabs = OSTabBarView()
    private var tabsHeight: NSLayoutConstraint!
    private var splash: UIView?
    private var observers: [NSObjectProtocol] = []

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Brand.homeBand

        let statusBand = UIView()
        statusBand.backgroundColor = Brand.statusBand
        statusBand.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusBand)

        addChild(web)
        let page: UIView = web.view
        page.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(page)
        web.didMove(toParent: self)

        // The native tab bar sits between the page and the home-indicator band, and the page is laid out ABOVE it, so
        // the site's own position-fixed bottom furniture (.ms-fab, .ms-resumebar, #toasts) lands on top of the bar
        // rather than under it — the page's viewport really is shorter. deviations.md D22.
        tabs.translatesAutoresizingMaskIntoConstraints = false
        tabs.onTap = { item in
            UISelectionFeedbackGenerator().selectionChanged()     // the web bar's own tabs buzz too (native.js wireHaptics)
            NotificationCenter.default.post(name: ShellViewController.tabTapped, object: item)
        }
        view.addSubview(tabs)
        tabsHeight = tabs.heightAnchor.constraint(equalToConstant: 0)

        let safe = view.safeAreaLayoutGuide
        // the page stops at whichever is higher: the tab bar, or the keyboard. Two "at most" constraints and one
        // breakable "exactly" is Auto Layout's way of writing min().
        let pageSitsOnBar = page.bottomAnchor.constraint(equalTo: tabs.topAnchor)
        pageSitsOnBar.priority = .defaultHigh
        NSLayoutConstraint.activate([
            statusBand.topAnchor.constraint(equalTo: view.topAnchor),
            statusBand.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            statusBand.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            statusBand.bottomAnchor.constraint(equalTo: safe.topAnchor),
            page.topAnchor.constraint(equalTo: safe.topAnchor),
            page.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            page.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            page.bottomAnchor.constraint(lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor),
            page.bottomAnchor.constraint(lessThanOrEqualTo: tabs.topAnchor),
            pageSitsOnBar,
            tabs.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            tabs.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            tabs.bottomAnchor.constraint(equalTo: safe.bottomAnchor),
            tabsHeight,
        ])

        addSplash(over: page)

        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: ShellViewController.hideSplash, object: nil, queue: .main) { [weak self] _ in
            self?.removeSplash()
        })
        observers.append(center.addObserver(forName: ShellViewController.setTabs, object: nil, queue: .main) { [weak self] note in
            self?.showTabs(note.object as? TabSpec)
        })
        // tapping the status bar scrolls the page to the top, as in every native list
        observers.append(center.addObserver(forName: .capacitorStatusBarTapped, object: nil, queue: .main) { [weak self] _ in
            guard let scroll = self?.web.webView?.scrollView else { return }
            scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: true)
        })
        // if the page never says it has drawn (the bridge failed to start), the splash must not be permanent
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in self?.removeSplash() }
    }

    private func addSplash(over page: UIView) {
        let width = Int(UIScreen.main.bounds.width.rounded())
        let pick = Brand.splashWidths.last(where: { $0 <= width }) ?? Brand.splashWidths[0]
        guard let top = UIImage(named: "SplashTop\(pick)"), let foot = UIImage(named: "SplashFoot\(pick)") else { return }

        let overlay = UIView()
        overlay.backgroundColor = .white                     // #ms-content is white
        overlay.isUserInteractionEnabled = false
        overlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(overlay)

        func strip(_ image: UIImage) -> UIImageView {
            let v = UIImageView(image: image)
            v.translatesAutoresizingMaskIntoConstraints = false
            overlay.addSubview(v)
            // at the exact rendered width this is 1:1; at another width it still fits edge to edge
            v.leadingAnchor.constraint(equalTo: overlay.leadingAnchor).isActive = true
            v.trailingAnchor.constraint(equalTo: overlay.trailingAnchor).isActive = true
            v.heightAnchor.constraint(equalTo: v.widthAnchor, multiplier: image.size.height / image.size.width).isActive = true
            return v
        }
        let topView = strip(top)
        let footView = strip(foot)
        NSLayoutConstraint.activate([
            overlay.topAnchor.constraint(equalTo: page.topAnchor),
            overlay.leadingAnchor.constraint(equalTo: page.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: page.trailingAnchor),
            overlay.bottomAnchor.constraint(equalTo: page.bottomAnchor),
            topView.topAnchor.constraint(equalTo: overlay.topAnchor),
            footView.bottomAnchor.constraint(equalTo: overlay.bottomAnchor),
        ])
        splash = overlay
    }

    private func removeSplash() {
        splash?.removeFromSuperview()
        splash = nil
    }

    /// Draw a measured bar (or nil for none) and give the page back the height if it changed.
    private func showTabs(_ spec: TabSpec?) {
        let changed = tabs.show(spec)
        if changed || tabsHeight.constant != tabs.barHeight {
            tabsHeight.constant = tabs.barHeight
            view.layoutIfNeeded()
        }
    }

    deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }
}

// Registers the app's own plugin (OurSpaceShell) with the bridge: Capacitor's way to add a plugin that lives in the app target.
final class AppBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ShellPlugin())
    }
}

// OurSpaceShell, as public/js/core/native.js sees it:
//   hideSplash()                    the page has painted: take the splash away
//   authenticate({ url, scheme })   ASWebAuthenticationSession (contract §6) → { url } the ourspace:// URL it ended on, or { cancelled: true }
//   setTabs({ spec })               draw the native tab bar from a spec core/tabspec.js measured; spec: null removes it
//   'tabTap' event                  { id, href } when one is tapped; core/tabbar.js routes it through the page's router
@objc(ShellPlugin)
public class ShellPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "ShellPlugin"
    public let jsName = "OurSpaceShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "hideSplash", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTabs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addListener", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "removeAllListeners", returnType: CAPPluginReturnPromise),
    ]

    private var session: ASWebAuthenticationSession?
    private var tabObserver: NSObjectProtocol?

    override public func load() {
        tabObserver = NotificationCenter.default.addObserver(forName: ShellViewController.tabTapped, object: nil, queue: .main) { [weak self] note in
            guard let item = note.object as? TabSpec.Item else { return }
            // href is never nil for a tab the page drew, but the bridge must get a String either way
            self?.notifyListeners("tabTap", data: ["id": item.id, "href": item.href ?? ""])
        }
    }

    deinit { if let o = tabObserver { NotificationCenter.default.removeObserver(o) } }

    @objc func hideSplash(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: ShellViewController.hideSplash, object: nil)
            call.resolve()
        }
    }

    /* The spec arrives as the JSON object core/tabspec.js produced. It is decoded here rather than read field by
       field so that a spec this build does not understand (a newer `v`) fails in one place, loudly, and the bar is
       simply not drawn — the page then still has its own web bar, because core/tabbar.js only takes it out of the
       flow after setTabs has been accepted. */
    @objc func setTabs(_ call: CAPPluginCall) {
        let raw = call.getObject("spec")
        DispatchQueue.main.async {
            guard let raw = raw else {
                NotificationCenter.default.post(name: ShellViewController.setTabs, object: nil)
                call.resolve(["drawn": false])
                return
            }
            do {
                let data = try JSONSerialization.data(withJSONObject: raw)
                let spec = try JSONDecoder().decode(TabSpec.self, from: data)
                guard spec.v == TabSpec.supportedVersion else {
                    call.reject("tab spec version \(spec.v); this build draws \(TabSpec.supportedVersion)")
                    return
                }
                NotificationCenter.default.post(name: ShellViewController.setTabs, object: spec)
                call.resolve(["drawn": true, "items": spec.items.count])
            } catch {
                call.reject("the tab spec did not decode: \(error.localizedDescription)")
            }
        }
    }

    @objc func authenticate(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), let scheme = call.getString("scheme") else {
            call.reject("authenticate needs a url and a scheme")
            return
        }
        DispatchQueue.main.async {
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] callback, error in
                self?.session = nil
                if let callback = callback {
                    call.resolve(["url": callback.absoluteString])
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    call.resolve(["cancelled": true])
                } else {
                    call.reject(error?.localizedDescription ?? "sign-in did not finish")
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false     // the provider's own cookies make "continue as …" one tap
            self.session = session
            if !session.start() {
                self.session = nil
                call.reject("could not open the sign-in sheet")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = ShellViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
