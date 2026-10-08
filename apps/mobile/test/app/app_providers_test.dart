import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/app/app_providers.dart';
import 'package:lookup_listener/core/configuration/app_configuration_provider.dart';
import 'package:lookup_listener/core/error_reporting/client_error_reporter.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/identify/data/recognition_repository.dart';
import 'package:lookup_listener/features/identify/presentation/recognition_flow.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/example_app_configurations.dart';
import '../support/fake_clock.dart';
import '../support/fake_http_client_adapter.dart';

ProviderContainer _appContainer() {
  final container = ProviderContainer(
    overrides: [
      appConfigurationProvider.overrideWithValue(ExampleAppConfigurations.production()),
      ...appServiceOverrides,
    ],
    retry: (retryCount, error) => null,
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('the real services are made from the checked configuration', () {
    final container = _appContainer();
    expect(container.read(apiClientProvider), isA<ApiClient>());
    expect(container.read(listenerInstallRepositoryProvider), isA<ListenerInstallRepository>());
    expect(container.read(clientErrorReporterProvider), isA<ClientErrorReporter>());
    expect(container.read(recognitionRepositoryProvider), isA<RecognitionRepository>());
    expect(container.read(developmentLogProvider).isOn, isFalse);
  });

  test('one of each: the same client, reporter and clock wherever they are read', () {
    final container = _appContainer();
    expect(container.read(apiClientProvider), same(container.read(apiClientProvider)));
    expect(
      container.read(clientErrorReporterProvider),
      same(container.read(clientErrorReporterProvider)),
    );
    expect(container.read(recognitionClockProvider), same(container.read(clockProvider)));
    expect(container.read(recognitionRandomUuidProvider), same(container.read(randomUuidProvider)));
  });

  test('without the configuration nothing can be made: it comes only from the check', () {
    final container = ProviderContainer(retry: (retryCount, error) => null);
    addTearDown(container.dispose);
    expect(() => container.read(apiClientProvider), throwsA(anything));
  });

  test('the recognize repository sends through the app\'s one API client', () async {
    final adapter = FakeHttpClientAdapter()
      ..answerJson(200, {
        'install_token': 'fake.install.token',
        'expires_at': '2026-11-07T12:00:00Z',
      });
    final clock = FakeClock();
    final container = ProviderContainer(
      overrides: [
        appConfigurationProvider.overrideWithValue(ExampleAppConfigurations.production()),
        clockProvider.overrideWithValue(clock),
        apiClientProvider.overrideWith(
          (ref) => ApiClient(
            configuration: ExampleAppConfigurations.production(),
            randomUuid: ref.watch(randomUuidProvider),
            clock: ref.watch(clockProvider),
            httpClientAdapter: adapter,
          ),
        ),
        ...appServiceOverrides,
      ],
      retry: (retryCount, error) => null,
    );
    addTearDown(container.dispose);
    expect(container.read(recognitionClockProvider), same(clock));
    expect(container.read(clockProvider), isA<Clock>());

    final registration = await container.read(listenerInstallRepositoryProvider).ensureRegistered();
    expect(registration, isA<ListenerInstallRegistered>());
    expect(
      adapter.requests.single.address.toString(),
      'https://api.lookup.invalid/api/v1/installs',
    );
  });
}
