import 'dart:async';
import 'dart:isolate';

import 'client_error_reporter.dart';

/// Reports errors an isolate did not catch (design §3.19): `bootstrap()` registers it on
/// `Isolate.current`, the last place an error the zones and `PlatformDispatcher.onError` missed
/// can be seen. Dart sends each error to the port as a two-item list, `[description, stack]`,
/// both text (the stack may be null); this decodes the pair and reports it as `uncaught`.
///
/// Only text arrives, so the rule that a `FormatException`'s or `DioException`'s text is never
/// sent is applied to the text: such a description is replaced by its type name.
class IsolateErrorListener {
  /// [readCurrentLocation] gives the current route path for the report's `location`.
  IsolateErrorListener({
    required ClientErrorReporter reporter,
    String Function()? readCurrentLocation,
  }) : _reporter = reporter,
       _readCurrentLocation = readCurrentLocation,
       _port = RawReceivePort() {
    _port.handler = _handleMessage;
  }

  final ClientErrorReporter _reporter;
  final String Function()? _readCurrentLocation;
  final RawReceivePort _port;

  /// The port errors are sent to, for `Isolate.addErrorListener` or `Isolate.spawn(onError:)`.
  SendPort get sendPort => _port.sendPort;

  /// Starts receiving [isolate]'s uncaught errors.
  void listenTo(Isolate isolate) => isolate.addErrorListener(sendPort);

  /// Stops receiving [isolate]'s uncaught errors.
  void stopListeningTo(Isolate isolate) => isolate.removeErrorListener(sendPort);

  /// Closes the port; nothing more is received.
  void close() => _port.close();

  /// The description and stack of one error message, or null when [message] is not the
  /// `[description, stack]` pair Dart sends.
  static ({String description, String? stack})? decodeErrorMessage(Object? message) {
    if (message is! List<Object?> || message.length != 2) return null;
    final [description, stack] = message;
    if (description is! String || (stack != null && stack is! String)) return null;
    return (description: _withholdQuotingText(description), stack: stack as String?);
  }

  void _handleMessage(Object? message) {
    try {
      final error = decodeErrorMessage(message);
      if (error == null) return;
      final stack = error.stack;
      unawaited(
        _reporter.report(
          kind: ClientErrorKind.uncaught,
          error: error.description,
          stackTrace: stack == null || stack.isEmpty ? null : StackTrace.fromString(stack),
          location: _currentLocation(),
        ),
      );
    } on Object {
      // Never throw from the last place errors are seen.
    }
  }

  static String _withholdQuotingText(String description) {
    for (final typeName in ClientErrorReporter.textWithheldTypeNames) {
      if (description == typeName || description.startsWith(RegExp('$typeName\\b'))) {
        return ClientErrorReporter.withheldDescriptionFor(typeName);
      }
    }
    return description;
  }

  String? _currentLocation() {
    try {
      return _readCurrentLocation?.call();
    } on Object {
      return null;
    }
  }
}
