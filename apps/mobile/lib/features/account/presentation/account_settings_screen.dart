import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/features/account/domain/account_answer.dart';
import 'package:lookup_listener/features/account/data/listener_account_repository.dart';
import 'package:lookup_listener/features/account/presentation/account_problem_words.dart';
import 'package:lookup_listener/features/account/presentation/account_sign_up_controller.dart';
import 'package:lookup_listener/features/account/presentation/account_sign_up_steps.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// Settings → Account at `/settings/account` (ADR-005, design §3.1): the account of this phone.
///
/// - **Signed in**: "Signed in as a***@gmail.com", **Sign out** (this phone leaves; the account stays) and **Delete
///   my account** (asks first, then erases the email, gender and age).
/// - **Signed out**: **Create account** and **Sign in**, which open the same steps as the gate, with no result
///   waiting. When they finish, this page shows the signed-in state.
///
/// The state is read from the server each time the page opens, since the app keeps nothing about the account but
/// the masked address it is told. With no signal the page says so and offers to try again.
class AccountSettingsScreen extends ConsumerStatefulWidget {
  const AccountSettingsScreen({super.key, required this.onBack});

  /// Returns to Settings.
  final VoidCallback onBack;

  @override
  ConsumerState<AccountSettingsScreen> createState() => _AccountSettingsScreenState();
}

class _AccountSettingsScreenState extends ConsumerState<AccountSettingsScreen> {
  AccountSignUpMode? _signingUp;

  void _leaveSteps() {
    ref.read(accountSignUpProvider.notifier).reset();
    setState(() => _signingUp = null);
  }

  Future<void> _signOut() async {
    final messenger = ScaffoldMessenger.of(context);
    final words = AppLocalizations.of(context);
    final answer = await ref.read(listenerAccountRepositoryProvider).signOut();
    if (!mounted) return;
    _say(messenger, answer is AccountDone ? words.accountSignedOutMessage : _problemWords(answer, words));
    ref.invalidate(accountSummaryProvider);
  }

  Future<void> _delete() async {
    final messenger = ScaffoldMessenger.of(context);
    final words = AppLocalizations.of(context);
    final tokens = context.lookUpTokens;
    final isConfirmed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      backgroundColor: tokens.colours.surface,
      sheetAnimationStyle: MediaQuery.disableAnimationsOf(context)
          ? AnimationStyle.noAnimation
          : AnimationStyle(duration: tokens.motion.slow, reverseDuration: tokens.motion.base),
      builder: (sheetContext) {
        final spacing = tokens.spacing;
        return SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(spacing.space6, 0, spacing.space6, spacing.space6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(header: true, child: Text(words.accountDeleteConfirmHeading, style: tokens.typeStyles.heading)),
              SizedBox(height: spacing.space2),
              Text(words.accountDeleteConfirmBody, style: tokens.typeStyles.body.copyWith(color: tokens.colours.muted)),
              SizedBox(height: spacing.space5),
              FilledButton(
                style: FilledButton.styleFrom(backgroundColor: tokens.colours.danger, foregroundColor: tokens.colours.surface),
                onPressed: () => Navigator.of(sheetContext).pop(true),
                child: Text(words.accountDeleteConfirmButton),
              ),
              TextButton(onPressed: () => Navigator.of(sheetContext).pop(false), child: Text(words.cancelButton)),
            ],
          ),
        );
      },
    );
    if (isConfirmed != true || !mounted) return;
    final answer = await ref.read(listenerAccountRepositoryProvider).deleteAccount();
    if (!mounted) return;
    _say(messenger, answer is AccountDone ? words.accountDeletedMessage : _problemWords(answer, words));
    ref.invalidate(accountSummaryProvider);
  }

  String _problemWords(AccountAnswer answer, AppLocalizations words) => switch (answer) {
    AccountRefused(:final problem) => AccountProblemWords.of(problem, words),
    _ => words.accountProblemServerFailure,
  };

  void _say(ScaffoldMessengerState messenger, String text) {
    final tokens = context.lookUpTokens;
    messenger.showSnackBar(
      SnackBar(content: Text(text)),
      snackBarAnimationStyle: MediaQuery.disableAnimationsOf(context)
          ? AnimationStyle.noAnimation
          : AnimationStyle(duration: tokens.motion.base, reverseDuration: tokens.motion.base),
    );
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<AccountSignUpState>(accountSignUpProvider, (previous, next) {
      if (next.isDone && !(previous?.isDone ?? false)) {
        ref.read(accountSignUpProvider.notifier).reset();
        ref.invalidate(accountSummaryProvider);
        setState(() => _signingUp = null);
      }
    });
    final mode = _signingUp;
    if (mode != null) return AccountSignUpSteps(mode: mode, onLeave: _leaveSteps);
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final words = AppLocalizations.of(context);
    final summary = ref.watch(accountSummaryProvider);
    final (body, footer) = switch (summary) {
      AsyncData(value: AccountSummaryRead(summary: final read)) when read.isSignedIn => (
        Text(words.accountSettingsSignedInAs(read.emailMasked ?? ''), style: tokens.typeStyles.body),
        <Widget>[
          FilledButton(onPressed: () => unawaited(_signOut()), child: Text(words.accountSignOutButton)),
          TextButton(
            onPressed: () => unawaited(_delete()),
            style: TextButton.styleFrom(foregroundColor: tokens.colours.danger),
            child: Text(words.accountDeleteButton),
          ),
        ],
      ),
      AsyncData(value: AccountSummaryRead()) => (
        Text(words.accountSettingsSignedOutIntro, style: tokens.typeStyles.body.copyWith(color: tokens.colours.muted)),
        <Widget>[
          FilledButton(
            onPressed: () => setState(() => _signingUp = AccountSignUpMode.create),
            child: Text(words.accountSettingsCreateButton),
          ),
          TextButton(
            onPressed: () => setState(() => _signingUp = AccountSignUpMode.signIn),
            child: Text(words.accountSettingsSignInButton),
          ),
        ],
      ),
      AsyncLoading() => (
        Row(
          children: [
            SizedBox.square(
              dimension: spacing.space6,
              child: CircularProgressIndicator(strokeWidth: 3, color: tokens.colours.accent, semanticsLabel: words.accountGettingResult),
            ),
          ],
        ),
        const <Widget>[],
      ),
      _ => (
        Text(words.accountSettingsReadFailed, style: tokens.typeStyles.body),
        <Widget>[FilledButton(onPressed: () => ref.invalidate(accountSummaryProvider), child: Text(words.tryAgainButton))],
      ),
    };
    return ScreenFrame(
      exitButton: ScreenExitButton.back(label: words.backButton, onPressed: widget.onBack),
      title: Semantics(
        header: true,
        child: Text(words.settingsAccount, style: tokens.typeStyles.body.copyWith(fontWeight: FontWeight.w700)),
      ),
      bodyPadding: EdgeInsets.fromLTRB(spacing.space6, spacing.space4, spacing.space6, spacing.space6),
      isFooterPinned: true,
      body: body,
      footer: footer,
    );
  }
}
