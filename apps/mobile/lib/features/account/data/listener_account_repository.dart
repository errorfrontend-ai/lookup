import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/listener_install/listener_install_repository.dart';
import 'package:lookup_listener/core/network/api_client.dart';
import 'package:lookup_listener/core/time/clock.dart';
import 'package:lookup_listener/features/account/domain/account_answer.dart';
import 'package:lookup_listener/features/account/data/account_response_parser.dart';
import 'package:lookup_listener/features/account/domain/listener_gender.dart';

/// The listener-account routes (ADR-005, design §4), one call at a time: ask for a code, check it, create the
/// account, read it, sign out, delete it.
///
/// - Every call first makes sure the install has a token, registering when it has none, and the token goes only in
///   the `Authorization` header. After a refused token (401) the install registers again, once, and the call is made
///   again, as the recognize route does.
/// - Nothing here logs or keeps the email, the code, the ticket, the gender or the age: they travel in the request
///   and are gone.
/// - It never throws. Each answer is an [AccountAnswer] the screens turn into the app's own words.
class ListenerAccountRepository {
  ListenerAccountRepository({
    required ApiClient apiClient,
    required ListenerInstallRepository listenerInstallRepository,
    Clock? clock,
    AccountResponseParser parser = const AccountResponseParser(),
  }) : _apiClient = apiClient,
       _listenerInstallRepository = listenerInstallRepository,
       _clock = clock ?? Clock(),
       _parser = parser;

  final ApiClient _apiClient;
  final ListenerInstallRepository _listenerInstallRepository;
  final Clock _clock;
  final AccountResponseParser _parser;

  /// Emails a 6-digit code to [email], which is already trimmed and lower-cased.
  Future<AccountAnswer> requestCode(String email) => _call(
    (installToken) => _apiClient.postJson(ListenerRoute.listenerAccountCode, {'email': email}, installToken: installToken),
    _parser.readCodeSent,
  );

  /// Checks the [code] that came to [email]: signed in, or a ticket for finishing a new account.
  Future<AccountAnswer> verifyCode({required String email, required String code}) => _call(
    (installToken) => _apiClient.postJson(
      ListenerRoute.listenerAccountVerify,
      {'email': email, 'code': code},
      installToken: installToken,
    ),
    _parser.readVerified,
  );

  /// Creates the account with the [ticket] a right code for a new email gave.
  Future<AccountAnswer> createAccount({
    required String email,
    required String ticket,
    required ListenerGender gender,
    required int age,
    required String consentTextVersion,
  }) => _call(
    (installToken) => _apiClient.postJson(
      ListenerRoute.listenerAccount,
      {
        'email': email,
        'ticket': ticket,
        'gender': gender.apiName,
        'age': age,
        'consent_text_version': consentTextVersion,
      },
      installToken: installToken,
    ),
    _parser.readCreated,
  );

  /// Whether this phone has an account, and its email masked.
  Future<AccountAnswer> describe() => _call(
    (installToken) => _apiClient.getJson(ListenerRoute.listenerAccount, installToken: installToken),
    _parser.readSummary,
  );

  /// This phone leaves its account; the account stays.
  Future<AccountAnswer> signOut() => _call(
    (installToken) => _apiClient.postJson(ListenerRoute.listenerAccountSignOut, const {}, installToken: installToken),
    _parser.readNoContent,
  );

  /// Deletes the account of this phone, with the email, gender and age in it.
  Future<AccountAnswer> deleteAccount() => _call(
    (installToken) => _apiClient.deleteJson(ListenerRoute.listenerAccount, installToken: installToken),
    _parser.readNoContent,
  );

  Future<AccountAnswer> _call(
    Future<ApiAnswer> Function(String installToken) send,
    AccountAnswer Function(ApiAnswer answer, {required DateTime now}) read, {
    String? refusedInstallToken,
  }) async {
    final registration = refusedInstallToken == null
        ? await _listenerInstallRepository.ensureRegistered()
        : await _listenerInstallRepository.registerAgainAfterRefusal(refusedToken: refusedInstallToken);
    switch (registration) {
      case ListenerInstallNotRegistered(:final answer):
        return _parser.readNotRegistered(answer, now: _clock.now());
      case ListenerInstallRegistered(:final installToken):
        final answer = await send(installToken);
        if (refusedInstallToken == null && answer is ApiAnswerReceived && answer.status == 401) {
          return _call(send, read, refusedInstallToken: installToken);
        }
        return read(answer, now: _clock.now());
    }
  }
}

/// The repository the account screens call (design §3.3).
///
/// It is made at start-up from the app's one API client and install repository, which `lib/core` builds, so the
/// app provides it with `listenerAccountRepositoryProvider.overrideWith(...)`; tests override it the same way, over
/// a fake HTTP adapter. Reading it without that override is a mistake in the app's set-up.
final Provider<ListenerAccountRepository> listenerAccountRepositoryProvider = Provider<ListenerAccountRepository>(
  (ref) => throw UnimplementedError(
    'Override listenerAccountRepositoryProvider at start-up with the app ListenerAccountRepository.',
  ),
  retry: (retryCount, error) => null,
);

/// The wall clock the account steps count a code's wait against. The real clock in the app; tests override it.
final Provider<Clock> accountClockProvider = Provider<Clock>((ref) => Clock(), retry: (retryCount, error) => null);

/// What the server says about this phone's account, for Settings → Account. Read each time that page opens.
final FutureProvider<AccountAnswer> accountSummaryProvider = FutureProvider.autoDispose<AccountAnswer>(
  (ref) => ref.watch(listenerAccountRepositoryProvider).describe(),
  retry: (retryCount, error) => null,
);
