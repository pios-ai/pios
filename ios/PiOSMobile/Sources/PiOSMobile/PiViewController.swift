import UIKit
import WebKit

/// PiViewController — WKWebView thin shell for PiOS
///
/// M1 scope:
///   - Load pios-home.html from configured PiOS backend host (Tailscale or LAN)
///   - Inject Bearer token into every request
///   - Expose JS→Native message handler for future IPC (v2 hook)
///
/// Configuration via Info.plist keys:
///   PiOSBackendURL  (default: http://localhost:17892 — set to your backend host)
///   PiOSAPIToken    (dev: read from bundle; prod: read from Keychain)
class PiViewController: UIViewController {

    // MARK: - Configuration

    private var backendURL: String {
        // Explicit Info.plist override always wins (non-empty string)
        if let cfg = Bundle.main.object(forInfoDictionaryKey: "PiOSBackendURL") as? String,
           !cfg.isEmpty {
            return cfg
        }
        // Compile-time default by target:
        // Simulator: share Mac loopback, can't reach Tailscale utun → localhost works.
        // Real device: localhost = the phone itself (won't work). User MUST set
        //   PiOSBackendURL in Info.plist to their backend host (Tailscale name / IP / LAN).
        //   No hardcoded default IP — varies per user.
        return "http://localhost:17892"
    }

    private var apiToken: String {
        // TODO(M2): read from iOS Keychain (SecItemCopyMatching)
        // M1 dev mode: read from environment variable injected at build time
        Bundle.main.object(forInfoDictionaryKey: "PiOSAPIToken") as? String ?? ""
    }

    // MARK: - View

    private lazy var webView: WKWebView = {
        let config = WKWebViewConfiguration()

        // TODO(v2): Live Activity / Dynamic Island IPC channel
        // window.webkit.messageHandlers.piNative.postMessage({type, payload})
        config.userContentController.add(self, name: "piNative")

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        return wv
    }()

    private let loadingIndicator = UIActivityIndicatorView(style: .large)

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Pi"
        setupUI()
        loadPiOS()
    }

    private func setupUI() {
        view.backgroundColor = .systemBackground
        webView.translatesAutoresizingMaskIntoConstraints = false
        loadingIndicator.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        view.addSubview(loadingIndicator)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            loadingIndicator.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            loadingIndicator.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    private func loadPiOS() {
        // M2: load mobile chat UI at /m/. Hello-world at / is M1 walking-skeleton fallback.
        guard let url = URL(string: "\(backendURL)/m/") else { return }
        var request = URLRequest(url: url)
        if !apiToken.isEmpty {
            request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
        }
        loadingIndicator.startAnimating()
        webView.load(request)
    }
}

// MARK: - WKNavigationDelegate

extension PiViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadingIndicator.stopAnimating()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadingIndicator.stopAnimating()
        showConnectionError(error)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        loadingIndicator.stopAnimating()
        showConnectionError(error)
    }

    private func showConnectionError(_ error: Error) {
        let alert = UIAlertController(
            title: "无法连接到 Pi",
            message: "请确认网络已连接，PiOS 后端服务正在运行。\n\n(\(error.localizedDescription))",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "重试", style: .default) { [weak self] _ in self?.loadPiOS() })
        present(alert, animated: true)
    }
}

// MARK: - WKScriptMessageHandler (v2 IPC hook)

extension PiViewController: WKScriptMessageHandler {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "piNative" else { return }
        // TODO(v2): dispatch message.body to native push token registration / Live Activity
        print("[PiOS] JS→Native: \(message.body)")
    }
}
