import Cocoa
import WebKit

private let ZOOM_KEY = "pageZoom"
private let FRAMES_KEY = "boardWindowFrames"
private let ZOOM_STEPS: [CGFloat] = [0.5, 0.65, 0.75, 0.85, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0]

private let DEFAULT_SIZE = NSSize(width: 1440, height: 900)

/**
 * WKUserContentController holds its message handlers strongly, and the handler
 * here is the window that owns the web view — a cycle that would keep every
 * closed window alive. Register this instead and let it hop through weakly.
 */
final class BridgeProxy: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: BoardWindow?

    init(_ target: BoardWindow) { self.target = target }

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target else {
            replyHandler(nil, "That window has closed")
            return
        }
        target.handleBridge(message, replyHandler: replyHandler)
    }
}

/**
 * One board window: its own NSWindow, its own web view, its own view of the
 * board. They all talk to the same server, so a card opened in one is the same
 * card in the other — what differs is where you are looking from, which is the
 * point on a desk with more than one screen.
 *
 * The window's number is passed to the page as `?w=N`, and the page keeps its
 * section and board selection under that number. Window 2 stays on the calendar
 * while window 1 stays on the board, across a relaunch.
 */
final class BoardWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    let index: Int
    let window: NSWindow
    let webView: WKWebView

    /// Told when the window goes away, so the app can forget it.
    var onClose: ((BoardWindow) -> Void)?

    /// Told when the board has finished loading, so the menu can read the page's
    /// own state rather than keeping a second copy of it.
    var onLoaded: ((BoardWindow) -> Void)?

    private let boardURL: URL

    init(index: Int, port: Int) {
        self.index = index
        self.boardURL = URL(string: "http://127.0.0.1:\(port)/?w=\(index)")!

        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        if webView.responds(to: Selector(("setInspectable:"))) {
            webView.setValue(true, forKey: "inspectable")
        }

        // A real title bar, deliberately. With .fullSizeContentView the web view
        // covers the whole frame — including the strip you drag the window by and
        // the few pixels at each edge you resize from — so the window could be
        // neither moved nor resized.
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: DEFAULT_SIZE),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )

        super.init()

        // The page can ask for real Finder dialogs through this. Only the app has
        // it; in a browser the page falls back to its own folder browser.
        config.userContentController.addScriptMessageHandler(
            BridgeProxy(self), contentWorld: .page, name: "host")

        webView.navigationDelegate = self
        webView.uiDelegate = self

        window.title = AppDelegate.appName
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(red: 0.043, green: 0.059, blue: 0.09, alpha: 1)
        window.minSize = NSSize(width: 720, height: 480)
        window.isMovableByWindowBackground = false
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.delegate = self
        // Same identifier for every board window, so macOS is willing to merge
        // them into tabs when that is what you want on one screen.
        window.tabbingIdentifier = "SessionBoard"
        window.isReleasedWhenClosed = false

        let container = NSView(frame: window.contentLayoutRect)
        container.autoresizingMask = [.width, .height]
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        window.contentView = container

        let saved = UserDefaults.standard.double(forKey: ZOOM_KEY)
        webView.pageZoom = saved > 0 ? CGFloat(saved) : 1.0
    }

    // MARK: - Placing

    /// Restore a frame from a previous run, or pick somewhere sensible.
    func place(frame: NSRect?, relativeTo others: [BoardWindow]) {
        if let frame {
            window.setFrame(frame, display: false)
        } else if let host = openOnScreen(avoiding: others) {
            let size = NSSize(width: min(DEFAULT_SIZE.width, host.visibleFrame.width),
                              height: min(DEFAULT_SIZE.height, host.visibleFrame.height))
            let origin = NSPoint(x: host.visibleFrame.midX - size.width / 2,
                                 y: host.visibleFrame.midY - size.height / 2)
            window.setFrame(NSRect(origin: origin, size: size), display: false)
        } else if let key = others.last {
            // Every screen is already in use: step down and across from the last
            // window, the way a stack of windows has always behaved.
            let from = key.window.frame
            window.setFrame(NSRect(x: from.minX + 32, y: from.minY - 32,
                                   width: from.width, height: from.height), display: false)
        } else {
            window.center()
        }
        ensureOnScreen()
    }

    /**
     * On a multi-monitor desk a new window should appear where you are looking:
     * the screen under the pointer if nothing is there yet, otherwise the first
     * screen with no board window on it. Only when every screen is occupied does
     * it fall back to stacking.
     */
    private func openOnScreen(avoiding others: [BoardWindow]) -> NSScreen? {
        let taken = others.map { $0.window.frame }
        func isFree(_ screen: NSScreen) -> Bool {
            !taken.contains { screen.frame.intersects($0) }
        }

        let pointer = NSEvent.mouseLocation
        if let under = NSScreen.screens.first(where: { $0.frame.contains(pointer) }), isFree(under) {
            return under
        }
        return NSScreen.screens.first(where: isFree)
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
            let target = NSScreen.main?.visibleFrame ?? NSRect(origin: .zero, size: DEFAULT_SIZE)
            let size = NSSize(
                width: min(max(frame.width, 900), target.width),
                height: min(max(frame.height, 600), target.height)
            )
            window.setFrame(NSRect(origin: .zero, size: size), display: true)
            window.center()
        }
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        onClose?(self)
    }

    // MARK: - Content

    func load() {
        webView.load(URLRequest(url: boardURL))
    }

    func showSplash(_ message: String) {
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
     * the app puts a real NSOpenPanel up and hands the path back. The sheet is
     * attached to the window that asked, not to whichever window is frontmost.
     */
    func handleBridge(_ message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        onLoaded?(self)
    }

    /** target="_blank" asks for a new window; send those out to the browser too. */
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }
}

/// A thin native shell around the Session Board UI: it owns the node server's
/// lifetime and hosts the page in real windows, so the board behaves like an
/// app in the Dock rather than a browser tab that has to be found again.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var windows: [BoardWindow] = []
    private var server: Process?
    private var startedServer = false
    private var serverReady = false
    private var appearanceItems: (dark: NSMenuItem, light: NSMenuItem)?

    private let port: Int = {
        if let s = Bundle.main.object(forInfoDictionaryKey: "SBPort") as? String, let p = Int(s) { return p }
        return 4317
    }()

    private var repoPath: String {
        (Bundle.main.object(forInfoDictionaryKey: "SBRepoPath") as? String) ?? ""
    }

    private var healthURL: URL { URL(string: "http://127.0.0.1:\(port)/api/prefs")! }

    /// What this build calls itself, from Info.plist — set by config.json at build time.
    static let appName: String =
        (Bundle.main.infoDictionary?["CFBundleName"] as? String) ?? "Claude Command"

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        restoreWindows()

        isServerUp { [weak self] up in
            guard let self else { return }
            if !up { self.startServer() }
            self.waitForServer(attempts: 40)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        saveFrames()
        // Only tear down a server this app started; one already running belongs
        // to a terminal the user is using and should outlive us.
        if startedServer, let server, server.isRunning {
            server.terminate()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            if windows.isEmpty { newWindow() } else { windows.first?.show() }
        }
        return true
    }

    // MARK: - Windows

    /**
     * How many windows there were last time, and where each one sat. On a desk
     * with two screens the layout is the setup — reopening one window in the
     * middle of the main display means arranging everything again every morning.
     */
    private func restoreWindows() {
        let saved = (UserDefaults.standard.array(forKey: FRAMES_KEY) as? [String]) ?? []
        let frames = saved.compactMap { NSRectFromString($0) }.filter { $0.width > 0 && $0.height > 0 }

        if frames.isEmpty {
            openWindow(frame: nil)
        } else {
            for frame in frames { openWindow(frame: frame) }
        }
        // Front-to-back order follows the saved order; the first is the one you
        // were last working in.
        windows.first?.show()
        NSApp.activate(ignoringOtherApps: true)
    }

    @discardableResult
    private func openWindow(frame: NSRect?, asTabOf host: NSWindow? = nil) -> BoardWindow {
        let board = BoardWindow(index: nextIndex(), port: port)
        board.onClose = { [weak self] closed in self?.forget(closed) }
        board.onLoaded = { [weak self] loaded in
            loaded.webView.evaluateJavaScript("window.__theme && window.__theme.get()") { value, _ in
                if let theme = value as? String { self?.markAppearance(theme) }
            }
        }
        board.place(frame: frame, relativeTo: windows)
        windows.append(board)

        if serverReady {
            board.load()
        } else {
            board.showSplash("Starting \(Self.appName)…")
        }

        if let host {
            host.addTabbedWindow(board.window, ordered: .above)
        }
        board.show()
        return board
    }

    /**
     * Reuse the lowest free number rather than always counting up, so a window
     * you close and reopen comes back to the section it was showing — the page
     * remembers per number.
     */
    private func nextIndex() -> Int {
        let used = Set(windows.map { $0.index })
        var n = 1
        while used.contains(n) { n += 1 }
        return n
    }

    private func forget(_ board: BoardWindow) {
        windows.removeAll { $0 === board }
        // Record what is left *before* the app can quit on the last close, so
        // closing your way out still restores the layout you had.
        saveFrames()
    }

    /// Skip an empty list: quitting by closing windows shouldn't erase the layout.
    private func saveFrames() {
        guard !windows.isEmpty else { return }
        let frames = windows.map { NSStringFromRect($0.window.frame) }
        UserDefaults.standard.set(frames, forKey: FRAMES_KEY)
    }

    /// The window the menu is talking about.
    private var current: BoardWindow? {
        if let key = NSApp.keyWindow, let match = windows.first(where: { $0.window === key }) {
            return match
        }
        return windows.last
    }

    @objc private func newWindow() {
        openWindow(frame: nil)
    }

    /// The + button in the tab bar, and Window ▸ New Tab.
    @objc func newWindowForTab(_ sender: Any?) {
        openWindow(frame: nil, asTabOf: current?.window)
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
                self.serverReady = true
                for board in self.windows { board.load() }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    self.waitForServer(attempts: attempts - 1)
                }
            }
        }
    }

    private func fail(_ message: String) {
        for board in windows {
            board.showSplash("""
            <div style="max-width:520px;text-align:center;line-height:1.6">
              <div style="color:#f43f5e;font-weight:600;margin-bottom:8px">Session Board couldn’t start</div>
              \(message)
            </div>
            """)
        }
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

        let fileItem = NSMenuItem()
        let file = NSMenu(title: "File")
        // ⌘N starts a session — the thing you do all day. ⌘T is a new board
        // tab, the same tab the + in the tab bar makes; a separate window is
        // the rarer ask and takes the shift.
        file.addItem(withTitle: "New Session", action: #selector(newSession), keyEquivalent: "n")
        file.addItem(withTitle: "New Tab", action: #selector(newWindowForTab(_:)), keyEquivalent: "t")
        let newWin = NSMenuItem(title: "New Window", action: #selector(newWindow), keyEquivalent: "N")
        newWin.keyEquivalentModifierMask = [.command, .shift]
        file.addItem(newWin)
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file
        main.addItem(fileItem)

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
        // These are menu items rather than page shortcuts on purpose: a key
        // equivalent is taken by the menu before the web view — and the
        // terminal inside it — ever sees the keystroke.
        view.addItem(withTitle: "Find Card…", action: #selector(findCard), keyEquivalent: "f")
        view.addItem(withTitle: "Morning Brief", action: #selector(showBrief), keyEquivalent: "b")
        // ⇧⌘B: the brief keeps plain ⌘B — it is the older habit — and billing
        // takes the shift, the same B one modifier over.
        let billing = NSMenuItem(title: "Billing", action: #selector(showBilling), keyEquivalent: "B")
        billing.keyEquivalentModifierMask = [.command, .shift]
        view.addItem(billing)
        view.addItem(withTitle: "Usage", action: #selector(showUsage), keyEquivalent: "u")
        view.addItem(.separator())
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

        // Light or dark is a decision you make about twice a year. It belongs in
        // a menu, not in the top of every board.
        let appearance = NSMenu(title: "Appearance")
        let darkItem = NSMenuItem(title: "Dark", action: #selector(useDark), keyEquivalent: "")
        let lightItem = NSMenuItem(title: "Light", action: #selector(useLight), keyEquivalent: "")
        appearance.addItem(darkItem)
        appearance.addItem(lightItem)
        appearanceItems = (dark: darkItem, light: lightItem)
        let appearanceItem = NSMenuItem(title: "Appearance", action: nil, keyEquivalent: "")
        appearanceItem.submenu = appearance
        view.addItem(appearanceItem)
        view.addItem(.separator())
        // ⌃⌘F, the system's own binding — ⌘F alone is Find.
        let fullScreen = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        view.addItem(fullScreen)
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        // Setting this makes AppKit append the open windows, and the tab commands
        // (Merge All Windows, Move Tab to New Window) that go with them.
        windowItem.submenu = windowMenu
        main.addItem(windowItem)

        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }

    @objc private func reload() {
        current?.load()
    }

    // MARK: - Page commands

    /// The page exposes `window.__app` (see App.tsx); each menu item is one call
    /// into it, against the window the menu is talking about.
    private func tellPage(_ method: String) {
        current?.webView.evaluateJavaScript("window.__app && window.__app.\(method)()")
    }

    @objc private func newSession() { tellPage("newSession") }
    @objc private func findCard() { tellPage("findCard") }
    @objc private func showBrief() { tellPage("showBrief") }
    @objc private func showBilling() { tellPage("showBilling") }
    @objc private func showUsage() { tellPage("showUsage") }

    // MARK: - Appearance

    /**
     * The page owns the theme — it is a CSS attribute and a localStorage key —
     * so the menu asks it to change rather than keeping its own copy. Every
     * window is told, because they share the stored value and would otherwise
     * disagree until the next reload.
     */
    private func setTheme(_ theme: String) {
        UserDefaults.standard.set(theme, forKey: "appTheme")
        markAppearance(theme)
        for board in windows {
            board.webView.evaluateJavaScript("window.__theme && window.__theme.set('\(theme)')")
        }
    }

    private func markAppearance(_ theme: String) {
        appearanceItems?.dark.state = theme == "dark" ? .on : .off
        appearanceItems?.light.state = theme == "light" ? .on : .off
    }

    @objc private func useDark() { setTheme("dark") }
    @objc private func useLight() { setTheme("light") }

    // MARK: - Zoom

    /// Zoom is per window — the laptop screen and a 32" display want different
    /// sizes — but the last one set is what a new window opens at.
    private func applyZoom(_ zoom: CGFloat) {
        current?.webView.pageZoom = zoom
        UserDefaults.standard.set(Double(zoom), forKey: ZOOM_KEY)
    }

    private func step(_ direction: Int) {
        let currentZoom = current?.webView.pageZoom ?? 1.0
        // Land on the nearest step first, so a zoom set elsewhere still moves one notch.
        let index = ZOOM_STEPS.enumerated().min {
            abs($0.element - currentZoom) < abs($1.element - currentZoom)
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
