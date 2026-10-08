import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform;

import '../configuration/app_version.dart';
import '../network/api_client.dart';
import 'listener_install_credentials.dart';
import 'listener_install_registration_result.dart';

/// One registration: `POST /api/v1/installs` with the install id, and the answer read into a token
/// (design §3.9, S4-INSTALLS-04). The request is exactly the contract's `RegisterInstallInput` and
/// the answer is read by the rules of `InstallRegistration`
/// (packages/contracts/schemas/register-install-input.schema.json and
/// install-registration.schema.json). When to register is the repository's decision.
class ListenerInstallRegistration {
  /// [appVersion] and [readPlatform] are for tests; the app sends its own version and the platform
  /// it runs on.
  ListenerInstallRegistration({
    required ApiClient apiClient,
    String appVersion = AppVersion.current,
    TargetPlatform Function()? readPlatform,
  }) : _apiClient = apiClient,
       _appVersion = appVersion,
       _readPlatform = readPlatform ?? _readDefaultTargetPlatform;

  /// The route, relative to the API's base address. It carries no install token.
  static const String path = 'installs';

  /// The longest token the contract allows.
  static const int longestInstallToken = 1024;

  /// The contract's `expires_at` rule: an RFC 3339 date-time with a time zone (`Z` or `+02:00`),
  /// copied from install-registration.schema.json.
  static final RegExp _dateTimeWithTimeZone = RegExp(
    r'^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|'
    r'\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|'
    r'(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?'
    r'(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$',
  );

  /// RFC 6750's bearer-token characters. Stricter than the contract, which allows any text of 1 to
  /// 1024 characters, because the token must travel in an `Authorization` header: a space or a line
  /// break there would break the header or forge another.
  static final RegExp _bearerToken = RegExp(r'^[A-Za-z0-9\-._~+/]+=*$');

  final ApiClient _apiClient;
  final String _appVersion;
  final TargetPlatform Function() _readPlatform;

  /// The registration body: the install id, `ANDROID` or `IOS`, and the app's version. Nothing
  /// else, so nothing about the phone or the listener is sent.
  Map<String, Object> requestBodyFor(String installId) => {
    'install_id': installId,
    'platform': _readPlatform() == TargetPlatform.iOS ? 'IOS' : 'ANDROID',
    'app_version': _appVersion,
  };

  /// Registers [credentials]' install id and gives the same install with its new token, or the
  /// failure as the API client reported it. Never throws.
  Future<ListenerInstallRegistrationResult> register(ListenerInstallCredentials credentials) async {
    final answer = await _apiClient.postJson(path, requestBodyFor(credentials.installId));
    switch (answer) {
      case ApiAnswerNotReceived():
        return ListenerInstallNotRegistered(answer: answer);
      case ApiAnswerReceived(status: != 200):
        return ListenerInstallNotRegistered(answer: answer);
      case ApiAnswerReceived(:final body):
        final Object? value;
        switch (body) {
          case JsonAnswerBody(value: final decoded):
            value = decoded;
          case NotJsonAnswerBody():
            return ListenerInstallNotRegistered(
              answer: answer,
              readingProblem: 'the body is not JSON',
            );
        }
        return _read(value, answer: answer, credentials: credentials);
    }
  }

  /// Reads a 200 body. Unknown fields are ignored rather than refused (S4-D15), so a newer API that
  /// adds one does not stop older apps from registering.
  ListenerInstallRegistrationResult _read(
    Object? value, {
    required ApiAnswer answer,
    required ListenerInstallCredentials credentials,
  }) {
    ListenerInstallRegistrationResult unreadable(String problem) =>
        ListenerInstallNotRegistered(answer: answer, readingProblem: problem);

    if (value is! Map<String, Object?>) return unreadable('the body is not a JSON object');
    final installToken = value['install_token'];
    if (installToken is! String) return unreadable('install_token is missing or not text');
    final installTokenLength = installToken.runes.length;
    if (installTokenLength < 1 || installTokenLength > longestInstallToken) {
      return unreadable('install_token is empty or longer than $longestInstallToken characters');
    }
    if (!_bearerToken.hasMatch(installToken)) {
      return unreadable('install_token has characters a bearer token cannot carry');
    }
    final expiresAtText = value['expires_at'];
    if (expiresAtText is! String) return unreadable('expires_at is missing or not text');
    final expiresAt = _dateTimeWithTimeZone.hasMatch(expiresAtText)
        ? DateTime.tryParse(expiresAtText)
        : null;
    if (expiresAt == null) return unreadable('expires_at is not a date-time with a time zone');
    return ListenerInstallRegistered(credentials.withToken(installToken, expiresAt));
  }

  static TargetPlatform _readDefaultTargetPlatform() => defaultTargetPlatform;
}
