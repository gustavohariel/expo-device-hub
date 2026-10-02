import CFNetwork
import Foundation

/// The proxies macOS would use for a URL, in order. CFNetwork applies the manual settings, the
/// bypass list and proxy auto-config: a PAC URL, or auto-discovery, which it turns into a PAC URL.
/// Network capture forwards each captured request the way the app would have sent it.
enum SystemProxy {
    struct Entry: Encodable, Equatable {
        let type: String  // "direct", "http", "https", "socks", or "unknown"
        let host: String?
        let port: Int?
    }

    enum Failure: Error, CustomStringConvertible {
        case invalidURL(String)
        case invalidSettings

        var description: String {
            switch self {
            case .invalidURL(let url): return "Not a URL: \(url)"
            case .invalidSettings: return "Proxy settings must be a JSON object."
            }
        }
    }

    /// JSON list of entries for `url`. Empty `settingsJSON` reads the live system settings; tests
    /// pass a settings dictionary in the SCDynamicStore shape instead. `timeout` bounds each PAC run.
    static func resolveJSON(_ url: String, settingsJSON: String, timeout: TimeInterval) throws -> String {
        guard let target = URL(string: url), target.host != nil else { throw Failure.invalidURL(url) }
        var settings: [String: Any]?
        if !settingsJSON.isEmpty {
            let parsed = try? JSONSerialization.jsonObject(with: Data(settingsJSON.utf8))
            guard let dictionary = parsed as? [String: Any] else { throw Failure.invalidSettings }
            settings = dictionary
        }
        let entries = resolve(target, settings: settings, timeout: timeout)
        return String(decoding: try JSONEncoder().encode(entries), as: UTF8.self)
    }

    static func resolve(_ url: URL, settings: [String: Any]?, timeout: TimeInterval) -> [Entry] {
        let current: CFDictionary
        if let settings {
            current = settings as CFDictionary
        } else if let live = CFNetworkCopySystemProxySettings()?.takeRetainedValue() {
            current = live
        } else {
            return []
        }
        let raw = CFNetworkCopyProxiesForURL(url as CFURL, current).takeRetainedValue() as? [[CFString: Any]] ?? []
        return raw.flatMap { expand($0, url: url, timeout: timeout) }
    }

    private static func expand(_ entry: [CFString: Any], url: URL, timeout: TimeInterval) -> [Entry] {
        let type = entry[kCFProxyTypeKey] as? String ?? ""
        if type == (kCFProxyTypeAutoConfigurationURL as String),
           let pacURL = entry[kCFProxyAutoConfigurationURLKey] as? URL {
            return runPac(timeout: timeout) { callback, context in
                CFNetworkExecuteProxyAutoConfigurationURL(pacURL as CFURL, url as CFURL, callback, context)
            }.map(convert)
        }
        if type == (kCFProxyTypeAutoConfigurationJavaScript as String),
           let script = entry[kCFProxyAutoConfigurationJavaScriptKey] as? String {
            return runPac(timeout: timeout) { callback, context in
                CFNetworkExecuteProxyAutoConfigurationScript(script as CFString, url as CFURL, callback, context)
            }.map(convert)
        }
        return [convert(entry)]
    }

    private static func convert(_ entry: [CFString: Any]) -> Entry {
        let type = entry[kCFProxyTypeKey] as? String ?? ""
        let names: [(CFString, String)] = [
            (kCFProxyTypeNone, "direct"), (kCFProxyTypeHTTP, "http"),
            (kCFProxyTypeHTTPS, "https"), (kCFProxyTypeSOCKS, "socks"),
        ]
        let name = names.first { ($0.0 as String) == type }?.1 ?? "unknown"
        if name == "direct" { return Entry(type: name, host: nil, port: nil) }
        return Entry(
            type: name,
            host: entry[kCFProxyHostNameKey] as? String,
            port: (entry[kCFProxyPortNumberKey] as? NSNumber)?.intValue)
    }

    private final class PacResult {
        var proxies: [[CFString: Any]]?
    }

    /// CFNetwork fetches and runs a PAC file or script through a run loop source, so this runs the
    /// calling thread's run loop for at most `timeout`. A PAC that cannot be fetched, fails, or does
    /// not finish in time yields nothing.
    private static func runPac(
        timeout: TimeInterval,
        start: (CFProxyAutoConfigurationResultCallback, UnsafeMutablePointer<CFStreamClientContext>) -> CFRunLoopSource
    ) -> [[CFString: Any]] {
        let result = PacResult()
        var context = CFStreamClientContext(
            version: 0, info: Unmanaged.passUnretained(result).toOpaque(),
            retain: nil, release: nil, copyDescription: nil)
        let callback: CFProxyAutoConfigurationResultCallback = { info, proxies, error in
            let result = Unmanaged<PacResult>.fromOpaque(info).takeUnretainedValue()
            result.proxies = error == nil ? (proxies as? [[CFString: Any]] ?? []) : []
            CFRunLoopStop(CFRunLoopGetCurrent())
        }
        let source = start(callback, &context)
        let mode = CFRunLoopMode(rawValue: "SystemProxyPAC" as CFString)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, mode)
        let deadline = Date().addingTimeInterval(timeout)
        while result.proxies == nil, Date() < deadline {
            _ = CFRunLoopRunInMode(mode, deadline.timeIntervalSinceNow, true)
        }
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, mode)
        CFRunLoopSourceInvalidate(source)
        return result.proxies ?? []
    }
}
