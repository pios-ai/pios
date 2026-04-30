import XCTest
@testable import PiOSMobile

/// PiOSMobileTests — M1 XCTest skeleton
///
/// Tests:
///   testPingReachable     — WKWebView fetch /mobile/ping → 200
///   testAuthRequired      — fetch /mobile/hello without token → 401
///   testHelloWorld        — fetch /mobile/hello with correct token → { ok: true }
///
/// Mock backend: local URLSession mock server started in setUp() so these tests
/// run without a real PiOS backend (CI safe).
///
/// To run against a real PiOS backend (set PI_BACKEND_URL to your host):
///   export PI_BACKEND_URL=http://localhost:17892
///   export PI_API_TOKEN=<token>
///   xcodebuild test -scheme PiOSMobile -destination 'platform=iOS Simulator,name=iPhone 16'
class PiOSMobileTests: XCTestCase {

    // MARK: - Mock Server

    /// Minimal URLProtocol mock to intercept URLSession requests in tests
    class MockURLProtocol: URLProtocol {
        static var handlers: [(URLRequest) -> (Data, HTTPURLResponse)?] = []

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            for handler in MockURLProtocol.handlers {
                if let (data, response) = handler(request) {
                    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                    client?.urlProtocol(self, didLoad: data)
                    client?.urlProtocolDidFinishLoading(self)
                    return
                }
            }
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
        }

        override func stopLoading() {}
    }

    var session: URLSession!
    let backendURL = ProcessInfo.processInfo.environment["PI_BACKEND_URL"] ?? "http://localhost:17892"
    let apiToken   = ProcessInfo.processInfo.environment["PI_API_TOKEN"] ?? "test-token-m1"

    override func setUp() {
        super.setUp()
        MockURLProtocol.handlers = []
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        session = URLSession(configuration: config)
    }

    // MARK: - Tests

    /// /mobile/ping returns 200 + { ok: true } — no auth required
    func testPingReachable() throws {
        MockURLProtocol.handlers = [{ request in
            guard request.url?.path == "/mobile/ping" else { return nil }
            let body = #"{"ok":true,"ts":1234567890,"service":"pios-mobile-backend","version":"0.1.0-m1"}"#
            let resp = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (body.data(using: .utf8)!, resp)
        }]

        let url = URL(string: "\(backendURL)/mobile/ping")!
        let exp = expectation(description: "ping")
        let task = session.dataTask(with: url) { data, response, error in
            XCTAssertNil(error)
            let http = response as! HTTPURLResponse
            XCTAssertEqual(http.statusCode, 200)
            let json = try! JSONSerialization.jsonObject(with: data!) as! [String: Any]
            XCTAssertEqual(json["ok"] as? Bool, true)
            exp.fulfill()
        }
        task.resume()
        wait(for: [exp], timeout: 5)
    }

    /// /mobile/hello without token returns 401
    func testAuthRequired() throws {
        MockURLProtocol.handlers = [{ request in
            guard request.url?.path == "/mobile/hello" else { return nil }
            let auth = request.value(forHTTPHeaderField: "Authorization") ?? ""
            if !auth.hasPrefix("Bearer ") {
                let body = #"{"error":"Unauthorized"}"#
                let resp = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!
                return (body.data(using: .utf8)!, resp)
            }
            return nil
        }]

        let url = URL(string: "\(backendURL)/mobile/hello")!
        let exp = expectation(description: "auth-required")
        let task = session.dataTask(with: url) { _, response, error in
            XCTAssertNil(error)
            let http = response as! HTTPURLResponse
            XCTAssertEqual(http.statusCode, 401)
            exp.fulfill()
        }
        task.resume()
        wait(for: [exp], timeout: 5)
    }

    /// /mobile/hello with correct token returns { ok: true }
    func testHelloWorld() throws {
        let expectedToken = apiToken
        MockURLProtocol.handlers = [{ request in
            guard request.url?.path == "/mobile/hello" else { return nil }
            let auth = request.value(forHTTPHeaderField: "Authorization") ?? ""
            let token = auth.hasPrefix("Bearer ") ? String(auth.dropFirst(7)) : ""
            if token == expectedToken {
                let body = #"{"ok":true,"message":"Hello from PiOS mobile-backend","version":"0.1.0-m1"}"#
                let resp = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (body.data(using: .utf8)!, resp)
            }
            let body = #"{"error":"Unauthorized"}"#
            let resp = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!
            return (body.data(using: .utf8)!, resp)
        }]

        var request = URLRequest(url: URL(string: "\(backendURL)/mobile/hello")!)
        request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
        let exp = expectation(description: "hello-world")
        let task = session.dataTask(with: request) { data, response, error in
            XCTAssertNil(error)
            let http = response as! HTTPURLResponse
            XCTAssertEqual(http.statusCode, 200)
            let json = try! JSONSerialization.jsonObject(with: data!) as! [String: Any]
            XCTAssertEqual(json["ok"] as? Bool, true)
            XCTAssertTrue((json["message"] as? String ?? "").contains("PiOS"))
            exp.fulfill()
        }
        task.resume()
        wait(for: [exp], timeout: 5)
    }
}
