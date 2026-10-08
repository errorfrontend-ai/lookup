import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart' show ErrorWidget, Widget;

import '../configuration/app_configuration.dart';
import '../widgets/plain_error_fallback.dart';
import 'client_error_reporter.dart';
import 'development_log.dart';

/// The app's global error handlers (design §3.19, S4-D26), installed by `bootstrap()` before
/// `runApp`, so no failure goes unreported and no listener sees Flutter's red screen:
///
/// | Hook | Report kind | Notes |
/// |---|---|---|
/// | `FlutterError.onError` | `render` | `FlutterError.presentError` only in development with verbose logs |
/// | `PlatformDispatcher.instance.onError` | `uncaught` | returns `true`: handled |
/// | `ErrorWidget.builder` | (reported by `FlutterError.onError`) | the plain fallback of §2.11 |
///
/// The isolate error listener is `IsolateErrorListener`. Each handler reports through the
/// [ClientErrorReporter], which scrubs the text, limits how often the same error is sent and
/// never throws; a handler never throws either.
class GlobalErrorHandlers {
  /// [readCurrentLocation] gives the current route path (e.g. `/listening`) for the report's
  /// `location`; without it reports carry none.
  GlobalErrorHandlers({
    required ClientErrorReporter reporter,
    required AppConfiguration configuration,
    String Function()? readCurrentLocation,
    DevelopmentLog developmentLog = const DevelopmentLog.off(),
  }) : _reporter = reporter,
       _configuration = configuration,
       _readCurrentLocation = readCurrentLocation,
       _developmentLog = developmentLog;

  final ClientErrorReporter _reporter;
  final AppConfiguration _configuration;
  final String Function()? _readCurrentLocation;
  final DevelopmentLog _developmentLog;

  /// Points Flutter's three hooks at this object's handlers.
  void install() {
    FlutterError.onError = handleFlutterError;
    PlatformDispatcher.instance.onError = handlePlatformError;
    ErrorWidget.builder = buildErrorWidget;
  }

  /// A failure Flutter caught while building, laying out, painting or handling input. Errors
  /// Flutter marks silent (expected ones, such as an image that could not be fetched over a poor
  /// connection) are shown in a development build but not reported, so reports stay about faults.
  void handleFlutterError(FlutterErrorDetails details) {
    try {
      if (_developmentLog.isOn) FlutterError.presentError(details);
      if (details.silent) return;
      unawaited(
        _reporter.report(
          kind: ClientErrorKind.render,
          error: details.exception,
          stackTrace: details.stack,
          location: _currentLocation(),
        ),
      );
    } on Object {
      // A handler that throws would take the app down with it; the reporter already never throws.
    }
  }

  /// An error nothing else caught. Returns `true` so the engine treats it as handled and does not
  /// print it in a release build.
  bool handlePlatformError(Object error, StackTrace stackTrace) {
    try {
      _developmentLog.recordEvent(
        'uncaught error',
        detail: ClientErrorReporter.describe(error),
        stackTrace: stackTrace,
      );
      unawaited(
        _reporter.report(
          kind: ClientErrorKind.uncaught,
          error: error,
          stackTrace: stackTrace,
          location: _currentLocation(),
        ),
      );
    } on Object {
      // As above: never throw from the last handler.
    }
    return true;
  }

  /// What a widget that failed to build shows: the plain fallback, with the error's own text only
  /// in a development build with `LOOKUP_SHOW_ERROR_DETAILS`. Not reported here: Flutter has
  /// already passed the same failure to [handleFlutterError].
  Widget buildErrorWidget(FlutterErrorDetails details) => PlainErrorFallback(
    errorDetails: details,
    showsErrorDetails: _configuration.showsErrorDetails,
  );

  String? _currentLocation() {
    try {
      return _readCurrentLocation?.call();
    } on Object {
      return null;
    }
  }
}
