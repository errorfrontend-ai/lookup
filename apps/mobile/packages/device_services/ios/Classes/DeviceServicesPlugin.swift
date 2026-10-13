import Flutter

/// The iOS side of `device_services`: not supported in Phase 6 (P6 design §3.15, gap 32). Every call answers
/// "not implemented", which the Dart side reads as "not supported": no notifications, a network assumed, nothing
/// metered, and one engine.
///
/// The network and launch event channels are registered all the same, with a handler that sends nothing: Flutter
/// reports a "listen" that no platform side answers as an app error, which would be sent as a crash report at every
/// start.
public class DeviceServicesPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(name: "zm.lookup.device_services/methods", binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(DeviceServicesPlugin(), channel: channel)
    for name in ["zm.lookup.device_services/network", "zm.lookup.device_services/launches"] {
      FlutterEventChannel(name: name, binaryMessenger: registrar.messenger()).setStreamHandler(SilentStreamHandler())
    }
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    result(FlutterMethodNotImplemented)
  }
}

/// A stream that is listened to and never sends an event.
class SilentStreamHandler: NSObject, FlutterStreamHandler {
  func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    return nil
  }
}
