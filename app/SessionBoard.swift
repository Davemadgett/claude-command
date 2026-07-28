import Cocoa
import WebKit

private let ZOOM_KEY = "pageZoom"
private let ZOOM_STEPS: [CGFloat] = [0.5, 0.65, 0.75, 0.85, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0]

/// A thin native shell around the Session Board UI: it owns the node server's
/// lifetime and hosts the page in a real window, so the board behaves like an
/// app in the Dock rather than a browser tab that has to be found again.
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
                         WKScriptMessageHandlerWithReply {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var startedServer = false

    private let port: Int = {
        if let s = Bundle.main.object(forInfoDictionaryKey: "SBPort") as? String, let p = Int(s) { return p }
        return 4317
    }()

    private var repoPath: String {
        (Bundle.main.object(forInfoDictionaryKey: "SBRepoPath") as? String) ?? ""
    }

    private var boardURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }
    private var healthURL: URL { URL(string: "http://127.0.0.1:\(port)/api/prefs")! }

    /// What this build calls itself, from Info.plist — set by config.json at build time.
    static let appName: String =
        (Bundle.main.infoDictionary?["CFBundleName"] as? String) ?? "Claude Command"

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        showSplash("Starting \(Self.appName)…")

        isServerUp { [weak self] up in
            guard let self else { return }
            if !up { self.startServer() }
            self.waitForServer(attempts: 40)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Only tear down a server this app started; one already running belongs
        // to a terminal the user is using and should outlive us.
        if startedServer, let server, server.isRunning {
            server.terminate()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    // MARK: - Window

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        // The page can ask for real Finder dialogs through this. Only the app has
        // it; in a browser the page falls back to its own folder browser.
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "host")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        if webView.responds(to: Selector(("setInspectable:"))) {
            webView.setValue(true, forKey: "inspectable")
        }

        // A real title bar, deliberately. With .fullSizeContentView the web view
        // covers the whole frame — including the strip you drag the window by and
        // the few pixels at each edge you resize from — so the window could be
        // neither moved nor resized.
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = Self.appName
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(red: 0.043, green: 0.059, blue: 0.09, alpha: 1)
        window.minSize = NSSize(width: 720, height: 480)
        window.isMovableByWindowBackground = false
        window.collectionBehavior.insert(.fullScreenPrimary)

        let container = NSView(frame: window.contentLayoutRect)
        container.autoresizingMask = [.width, .height]
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        window.contentView = container

        webView.pageZoom = CGFloat(UserDefaults.standard.double(forKey: ZOOM_KEY) > 0
            ? UserDefaults.standard.double(forKey: ZOOM_KEY)
            : 1.0)

        window.setFrameAutosaveName("SessionBoardWindow")
        ensureOnScreen()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /**
     * A frame restored from a previous run can land somewhere unreachable — an
     * external display that is no longer attached, or a negative Y that puts the
     * title bar above the menu bar. The window is then impossible to move or
     * resize by hand, because the part you grab is off-screen. Put it back.
     */
    private func ensureOnScreen() {
        let frame = window.frame
        // The top strip is what you actually drag; that is what has to be reachable.
        let grabBar = NSRect(x: frame.minX, y: frame.maxY - 40, width: frame.width, height: 40)

        let reachable = NSScreen.screens.contains { screen in
            let overlap = screen.visibleFrame.intersection(grabBar)
            return overlap.width >= 80 && overlap.height >= 20
        }

        if !reachable {
            let target = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let size = NSSize(
                width: min(max(frame.width, 900), target.width),
                height: min(max(frame.height, 600), target.height)
            )
            window.setFrame(NSRect(origin: .zero, size: size), display: true)
            window.center()
        }
    }

    private func showSplash(_ message: String) {
        let html = """
        <html><head><meta charset="utf-8"></head>
        <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
                     background:#0b0f17;color:#97a3b8;
                     font:14px ui-sans-serif,-apple-system,system-ui,sans-serif">
          \(message)
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: - Server

    /// Resolve a tool through a login shell, since an app launched from the Dock
    /// inherits none of the user's PATH.
    private func which(_ tool: String) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "command -v \(tool)"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        p.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let path = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    private func startServer() {
        let candidates = [
            which("node"),
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ].compactMap { $0 }

        guard let node = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            fail("Couldn’t find node. Install Node, or start the server yourself with `npm start` in \(repoPath).")
            return
        }
        guard FileManager.default.fileExists(atPath: repoPath + "/server/index.js") else {
            fail("\(Self.appName) isn’t where this app expects it:<br><code>\(repoPath)</code><br>Re-run <code>app/build.sh</code>.")
            return
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [repoPath + "/server/index.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: repoPath)
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        p.environment = env
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice

        do {
            try p.run()
            server = p
            startedServer = true
        } catch {
            fail("Couldn’t start the server: \(error.localizedDescription)")
        }
    }

    private func isServerUp(_ done: @escaping (Bool) -> Void) {
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    private func waitForServer(attempts: Int) {
        guard attempts > 0 else {
            fail("The server didn’t come up on port \(port).")
            return
        }
        isServerUp { [weak self] up in
            guard let self else { return }
            if up {
                self.webView.load(URLRequest(url: self.boardURL))
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    self.waitForServer(attempts: attempts - 1)
                }
            }
        }
    }

    private func fail(_ message: String) {
        showSplash("""
        <div style="max-width:520px;text-align:center;line-height:1.6">
          <div style="color:#f43f5e;font-weight:600;margin-bottom:8px">Session Board couldn’t start</div>
          \(message)
        </div>
        """)
    }

    // MARK: - Menu

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About \(Self.appName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide \(Self.appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit \(Self.appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // xterm.js relies on the standard editing responders for paste to work.
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(.separator())

        view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        // ⌘+ needs shift on a US keyboard; ⌘= is what people actually press, so
        // bind both and hide the duplicate from the menu.
        let zoomInAlt = NSMenuItem(title: "Zoom In", action: #selector(zoomIn), keyEquivalent: "=")
        zoomInAlt.isHidden = true
        zoomInAlt.isAlternate = false
        view.addItem(zoomInAlt)

        view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        view.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
        view.addItem(.separator())
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)

        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }

    @objc private func reload() {
        webView.load(URLRequest(url: boardURL))
    }

    // MARK: - JavaScript dialogs

    /**
     * A WKWebView answers `prompt()` with null and `confirm()` with false unless
     * the UI delegate puts a panel up — silently, with no error. Renaming a card
     * or a board, and every delete confirmation, depend on these; without them
     * the commands appear to do nothing at all.
     */
    private func panel(_ message: String) -> NSAlert {
        let alert = NSAlert()
        // Page dialogs are written as a headline and an explanation; split them
        // so the sheet reads the way a Mac dialog should.
        let parts = message.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
        alert.messageText = String(parts.first ?? "")
        if parts.count > 1 {
            alert.informativeText = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return alert
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = panel(message)
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = panel(message)
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = panel(prompt)
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        field.placeholderString = "Name"
        alert.accessoryView = field

        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
        // Focus the field so you can just type, and preselect for a quick replace.
        alert.window.makeFirstResponder(field)
        field.currentEditor()?.selectAll(nil)
    }

    // MARK: - Native bridge

    /**
     * "Working directory" is a developer's phrase for a thing everyone already
     * knows how to do: point at a folder. A web page cannot open a folder
     * chooser — `<input type="file">` hands JavaScript a file, never a path — so
     * the app puts a real NSOpenPanel up and hands the path back.
     */
    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any],
              let cmd = body["cmd"] as? String else {
            replyHandler(nil, "Malformed bridge message")
            return
        }

        switch cmd {
        case "chooseFolder":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.canCreateDirectories = true
            panel.prompt = "Use This Folder"
            panel.message = "Choose the folder Claude should work in."
            if let start = body["start"] as? String, !start.isEmpty {
                let expanded = (start as NSString).expandingTildeInPath
                if FileManager.default.fileExists(atPath: expanded) {
                    panel.directoryURL = URL(fileURLWithPath: expanded)
                }
            }
            panel.beginSheetModal(for: window) { response in
                replyHandler(response == .OK ? panel.url?.path : nil, nil)
            }

        default:
            replyHandler(nil, "Unknown command: \(cmd)")
        }
    }

    // MARK: - Links

    /**
     * Anything that isn't our own server opens in the default browser. Without
     * this, clicking a Clio matter link would navigate the whole app window to
     * Clio with no way back.
     */
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let isOurs = url.host == "127.0.0.1" || url.host == "localhost" || url.scheme == "about"
        if isOurs {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    /** target="_blank" asks for a new window; send those out to the browser too. */
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: - Zoom

    private func applyZoom(_ zoom: CGFloat) {
        webView.pageZoom = zoom
        UserDefaults.standard.set(Double(zoom), forKey: ZOOM_KEY)
    }

    private func step(_ direction: Int) {
        let current = webView.pageZoom
        // Land on the nearest step first, so a zoom set elsewhere still moves one notch.
        let index = ZOOM_STEPS.enumerated().min {
            abs($0.element - current) < abs($1.element - current)
        }?.offset ?? ZOOM_STEPS.firstIndex(of: 1.0)!
        let next = min(max(index + direction, 0), ZOOM_STEPS.count - 1)
        applyZoom(ZOOM_STEPS[next])
    }

    @objc private func zoomIn() { step(1) }
    @objc private func zoomOut() { step(-1) }
    @objc private func zoomReset() { applyZoom(1.0) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
