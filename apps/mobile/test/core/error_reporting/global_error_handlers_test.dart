import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart' show ErrorWidget;
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/app_configuration.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/error_reporting/development_log.dart';
import 'package:lookup_listener/core/error_reporting/global_error_handlers.dart';
import 'package:lookup_listener/core/widgets/plain_error_fallback.dart';

import '../../support/example_app_configurations.dart';
import '../../support/recording_client_error_reporter.dart';

/// A reporter that fails as badly as it can, to prove the handlers survive it.
class _ThrowingClientErrorReporter extends RecordingClientErrorReporter {
  @override
  Future<ClientErrorReportOutcome> report({
    required ClientErrorKind kind,
    required Object error,
    StackTrace? stackTrace,
    String? description,
    String? location,
    String? relatedRequestId,
    String? reportRequestId,
  }) => throw StateError('the reporter is broken');
}

void main() {
  late RecordingClientErrorReporter reporter;
  late List<FlutterErrorDetails> presented;
  late FlutterExceptionHandler flutterPresentError;

  setUp(() {
    reporter = RecordingClientErrorReporter();
    presented = [];
    flutterPresentError = FlutterError.presentError;
    FlutterError.presentError = presented.add;
  });

  tearDown(() => FlutterError.presentError = flutterPresentError);

  GlobalErrorHandlers handlersFor(
    AppConfiguration configuration, {
    RecordingClientErrorReporter? withReporter,
    String Function()? readCurrentLocation,
  }) => GlobalErrorHandlers(
    reporter: withReporter ?? reporter,
    configuration: configuration,
    readCurrentLocation: readCurrentLocation ?? () => '/listening',
    developmentLog: DevelopmentLog(configuration: configuration, writeLine: (_) {}),
  );

  FlutterErrorDetails detailsOf(Object exception, {bool silent = false}) => FlutterErrorDetails(
    exception: exception,
    stack: StackTrace.fromString('#0 build (home_screen.dart:12)'),
    library: 'widgets library',
    silent: silent,
  );

  test('install points all three of Flutter\'s hooks at the handlers', () {
    final flutterOnError = FlutterError.onError;
    final platformOnError = PlatformDispatcher.instance.onError;
    final errorWidgetBuilder = ErrorWidget.builder;
    try {
      handlersFor(ExampleAppConfigurations.production()).install();
      expect(FlutterError.onError, isNot(same(flutterOnError)));
      expect(PlatformDispatcher.instance.onError, isNotNull);
      expect(ErrorWidget.builder, isNot(same(errorWidgetBuilder)));

      FlutterError.onError!(detailsOf(StateError('render failure')));
      expect(PlatformDispatcher.instance.onError!(StateError('lost'), StackTrace.empty), isTrue);
      expect(ErrorWidget.builder(detailsOf(StateError('x'))), isA<PlainErrorFallback>());
      expect(reporter.reports.map((report) => report.kind), [
        ClientErrorKind.render,
        ClientErrorKind.uncaught,
      ]);
    } finally {
      FlutterError.onError = flutterOnError;
      PlatformDispatcher.instance.onError = platformOnError;
      ErrorWidget.builder = errorWidgetBuilder;
    }
  });

  group('FlutterError.onError', () {
    test('reaches the reporter once, as render, with the error, stack and location', () {
      final error = StateError('render failure');
      final details = detailsOf(error);
      handlersFor(ExampleAppConfigurations.production()).handleFlutterError(details);
      final report = reporter.reports.single;
      expect(report.kind, ClientErrorKind.render);
      expect(report.error, same(error));
      expect(report.stackTrace, same(details.stack));
      expect(report.location, '/listening');
    });

    test('does not report errors Flutter marks silent', () {
      handlersFor(
        ExampleAppConfigurations.production(),
      ).handleFlutterError(detailsOf(StateError('image fetch failed'), silent: true));
      expect(reporter.reports, isEmpty);
    });

    test('presents the error on the device log only in development with verbose logs', () {
      final details = detailsOf(StateError('x'));
      handlersFor(ExampleAppConfigurations.production()).handleFlutterError(details);
      handlersFor(ExampleAppConfigurations.staging()).handleFlutterError(details);
      handlersFor(ExampleAppConfigurations.development()).handleFlutterError(details);
      expect(presented, isEmpty);
      handlersFor(
        ExampleAppConfigurations.development(writesVerboseLogs: true),
      ).handleFlutterError(details);
      expect(presented, [same(details)]);
    });

    test('survives a broken reporter and a broken location', () {
      final handlers = handlersFor(
        ExampleAppConfigurations.production(),
        withReporter: _ThrowingClientErrorReporter(),
        readCurrentLocation: () => throw StateError('no router'),
      );
      expect(() => handlers.handleFlutterError(detailsOf(StateError('x'))), returnsNormally);
    });

    test('reports without a location when the route cannot be read', () {
      handlersFor(
        ExampleAppConfigurations.production(),
        readCurrentLocation: () => throw StateError('no router'),
      ).handleFlutterError(detailsOf(StateError('x')));
      expect(reporter.reports.single.location, isNull);
    });
  });

  group('PlatformDispatcher.instance.onError', () {
    test('reaches the reporter as uncaught and returns true (handled)', () {
      final error = StateError('nobody awaited this');
      final stack = StackTrace.fromString('#0 send (repository.dart:40)');
      final isHandled = handlersFor(
        ExampleAppConfigurations.production(),
      ).handlePlatformError(error, stack);
      expect(isHandled, isTrue);
      final report = reporter.reports.single;
      expect(report.kind, ClientErrorKind.uncaught);
      expect(report.error, same(error));
      expect(report.stackTrace, same(stack));
      expect(report.location, '/listening');
    });

    test('still returns true when the reporter is broken', () {
      final handlers = handlersFor(
        ExampleAppConfigurations.production(),
        withReporter: _ThrowingClientErrorReporter(),
      );
      expect(handlers.handlePlatformError(StateError('x'), StackTrace.empty), isTrue);
    });
  });

  group('ErrorWidget.builder', () {
    test('builds the plain fallback, with details only when the build shows them', () {
      final details = detailsOf(StateError('x'));
      final plain =
          handlersFor(ExampleAppConfigurations.production()).buildErrorWidget(details)
              as PlainErrorFallback;
      expect(plain.showsErrorDetails, isFalse);
      expect(plain.errorDetails, same(details));

      final withDetails =
          handlersFor(
                AppConfiguration(
                  flavour: AppFlavour.development,
                  apiBaseUrl: Uri.parse('http://10.0.2.2:3100/api/v1'),
                  showsErrorDetails: true,
                ),
              ).buildErrorWidget(details)
              as PlainErrorFallback;
      expect(withDetails.showsErrorDetails, isTrue);
    });

    test('does not report: FlutterError.onError already has', () {
      handlersFor(
        ExampleAppConfigurations.production(),
      ).buildErrorWidget(detailsOf(StateError('x')));
      expect(reporter.reports, isEmpty);
    });
  });
}
