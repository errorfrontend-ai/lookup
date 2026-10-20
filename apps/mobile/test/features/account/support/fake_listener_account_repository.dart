import 'dart:async';

import 'package:lookup_listener/features/account/data/listener_account_repository.dart';
import 'package:lookup_listener/features/account/domain/account_answer.dart';
import 'package:lookup_listener/features/account/domain/listener_gender.dart';

/// A repository that answers what the test says, and records what it was asked.
final class FakeListenerAccountRepository implements ListenerAccountRepository {
  final List<String> calls = [];
  final List<Completer<AccountAnswer>> held = [];
  AccountAnswer Function()? next;

  /// What a method answers, by its name (`describe`, `signOut`…), instead of [next].
  final Map<String, AccountAnswer Function()> answers = {};
  Map<String, Object?>? lastCreation;

  Future<AccountAnswer> _answer(String call) {
    calls.add(call);
    if (held.isNotEmpty) return held.removeAt(0).future;
    final answer = answers[call.split(' ').first] ?? next;
    return Future.value(answer!());
  }

  @override
  Future<AccountAnswer> requestCode(String email) => _answer('requestCode $email');

  @override
  Future<AccountAnswer> verifyCode({required String email, required String code}) => _answer('verifyCode $email $code');

  @override
  Future<AccountAnswer> createAccount({
    required String email,
    required String ticket,
    required ListenerGender gender,
    required int age,
    required String consentTextVersion,
  }) {
    lastCreation = {'email': email, 'ticket': ticket, 'gender': gender, 'age': age, 'consent': consentTextVersion};
    return _answer('createAccount');
  }

  @override
  Future<AccountAnswer> describe() => _answer('describe');

  @override
  Future<AccountAnswer> signOut() => _answer('signOut');

  @override
  Future<AccountAnswer> deleteAccount() => _answer('deleteAccount');
}
