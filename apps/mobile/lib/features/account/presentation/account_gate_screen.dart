import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart' show SemanticsRole;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/core/widgets/screen_frame.dart';
import 'package:lookup_listener/core/widgets/state_icon_circle.dart';
import 'package:lookup_listener/features/account/domain/account_result_problem.dart';
import 'package:lookup_listener/features/account/presentation/account_sign_up_controller.dart';
import 'package:lookup_listener/features/account/presentation/account_sign_up_steps.dart';
import 'package:lookup_listener/features/identify/presentation/state_heading.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// The account gate, the `accountRequired` state at `/account` (ADR-005, design §3.1): the ad was recognised, but its
/// result waits for an account, and the server has not sent it. Shown instead of the result.
///
/// - **Intro**: "One more step to see your result", why an account is asked for, **Create account**, **I already
///   have an account** and **Not now**.
/// - **The steps**: the email, the code, and for a new email gender and age ([AccountSignUpSteps]). Back from the
///   first step returns here.
/// - **Getting your result**: once the account exists, [onSignedIn] asks for the held-back result. When it is shown,
///   the flow has already moved on and this screen leaves with its state. When it cannot be fetched, the screen says
///   why and offers to try again.
///
/// **Not now**, Close and system Back call [onNotNow]; the scan stays in History as "Create an account to see this
/// result". Nothing about the ad is on this screen: none of it reached the phone.
class AccountGateScreen extends ConsumerStatefulWidget {
  const AccountGateScreen({super.key, required this.onNotNow, required this.onSignedIn});

  /// Leaves without an account.
  final VoidCallback onNotNow;

  /// Asks for the result that was held back, once this phone has an account. Completes with null when the result is
  /// shown, or with why it could not be.
  final Future<AccountResultProblem?> Function() onSignedIn;

  @override
  ConsumerState<AccountGateScreen> createState() => _AccountGateScreenState();
}

class _AccountGateScreenState extends ConsumerState<AccountGateScreen> {
  AccountSignUpMode? _mode;
  bool _isGettingResult = false;
  AccountResultProblem? _resultProblem;

  Future<void> _showResult() async {
    setState(() {
      _isGettingResult = true;
      _resultProblem = null;
    });
    final problem = await widget.onSignedIn();
    if (!mounted) return;
    // With no problem the result is showing, and the flow moves this screen away; nothing to change here.
    if (problem != null) {
      setState(() {
        _isGettingResult = false;
        _resultProblem = problem;
      });
    }
  }

  void _leaveSteps() {
    ref.read(accountSignUpProvider.notifier).reset();
    setState(() => _mode = null);
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<AccountSignUpState>(accountSignUpProvider, (previous, next) {
      if (next.isDone && !(previous?.isDone ?? false)) unawaited(_showResult());
    });
    final words = AppLocalizations.of(context);
    if (_isGettingResult) return _gettingResult(context, words);
    final resultProblem = _resultProblem;
    if (resultProblem != null) return _resultProblemScreen(context, words, resultProblem);
    final mode = _mode;
    if (mode != null) return AccountSignUpSteps(mode: mode, onLeave: _leaveSteps);
    return _intro(context, words);
  }

  Widget _intro(BuildContext context, AppLocalizations words) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    return PopScope<Object?>(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) widget.onNotNow();
      },
      child: ScreenFrame(
        exitButton: ScreenExitButton.close(label: words.accountGateNotNowButton, onPressed: widget.onNotNow),
        isFooterPinned: true,
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            StateIconCircle(icon: Icons.lock_outline, iconColour: colours.accent, circleColour: colours.accentSoft),
            SizedBox(height: spacing.space5),
            StateHeading(words.accountGateHeading, role: SemanticsRole.status),
            SizedBox(height: spacing.space2),
            Text(words.accountGateExplanation, style: tokens.typeStyles.body.copyWith(color: colours.muted)),
          ],
        ),
        footer: [
          FilledButton(
            onPressed: () => setState(() => _mode = AccountSignUpMode.create),
            child: Text(words.accountGateCreateButton),
          ),
          TextButton(
            onPressed: () => setState(() => _mode = AccountSignUpMode.signIn),
            child: Text(words.accountGateSignInButton),
          ),
          TextButton(onPressed: widget.onNotNow, child: Text(words.accountGateNotNowButton)),
        ],
      ),
    );
  }

  Widget _gettingResult(BuildContext context, AppLocalizations words) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    return PopScope<Object?>(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) widget.onNotNow();
      },
      child: ScreenFrame(
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(height: spacing.space10),
            Center(
              child: SizedBox.square(
                dimension: spacing.space10,
                child: ExcludeSemantics(child: CircularProgressIndicator(strokeWidth: 4, color: tokens.colours.accent)),
              ),
            ),
            SizedBox(height: spacing.space5),
            StateHeading(words.accountGettingResult, role: SemanticsRole.status, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }

  Widget _resultProblemScreen(BuildContext context, AppLocalizations words, AccountResultProblem problem) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final (heading, canTryAgain) = switch (problem) {
      AccountResultProblem.noConnection => (words.accountProblemNoConnection, true),
      AccountResultProblem.notFound => (words.accountResultNotFound, false),
      AccountResultProblem.serverFailure => (words.accountProblemServerFailure, true),
    };
    return PopScope<Object?>(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) widget.onNotNow();
      },
      child: ScreenFrame(
        exitButton: ScreenExitButton.close(label: words.closeButton, onPressed: widget.onNotNow),
        isFooterPinned: true,
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            StateIconCircle(icon: Icons.signal_cellular_off_outlined, iconColour: colours.warning, circleColour: colours.warningSoft),
            SizedBox(height: spacing.space5),
            StateHeading(heading, role: SemanticsRole.alert),
          ],
        ),
        footer: [
          if (canTryAgain) FilledButton(onPressed: () => unawaited(_showResult()), child: Text(words.accountResultRetryButton)),
          if (canTryAgain)
            TextButton(onPressed: widget.onNotNow, child: Text(words.accountGateNotNowButton))
          else
            FilledButton(onPressed: widget.onNotNow, child: Text(words.backToHomeButton)),
        ],
      ),
    );
  }
}
