import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/core/widgets/screen_exit_button.dart';
import 'package:lookup_listener/features/account/data/listener_account_repository.dart';
import 'package:lookup_listener/features/account/domain/account_problem.dart';
import 'package:lookup_listener/features/account/domain/account_rules.dart';
import 'package:lookup_listener/features/account/domain/listener_gender.dart';
import 'package:lookup_listener/features/account/presentation/account_problem_words.dart';
import 'package:lookup_listener/features/account/presentation/account_sign_up_controller.dart';
import 'package:lookup_listener/features/account/presentation/account_step_frame.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// Whether the listener chose to create an account or to sign in: only the words differ, the steps are the same.
enum AccountSignUpMode { create, signIn }

/// The three steps of creating an account or signing in (ADR-005, design §3.1): **Your email**, **Enter the code**
/// and, for an email with no account yet, **About you** (gender, age and the consent tick).
///
/// Each step is a full screen with Back, its fields, and its one main button pinned above the keyboard. The steps
/// are driven by [accountSignUpProvider]; this widget keeps only what is being typed. Back on the first step, and
/// system Back there, call [onLeave], which the host decides (the gate's first page, or Settings). Every problem is
/// said in the app's own words, in the step it belongs to.
class AccountSignUpSteps extends ConsumerStatefulWidget {
  const AccountSignUpSteps({super.key, required this.mode, required this.onLeave});

  final AccountSignUpMode mode;

  /// Back from the first step.
  final VoidCallback onLeave;

  @override
  ConsumerState<AccountSignUpSteps> createState() => _AccountSignUpStepsState();
}

class _AccountSignUpStepsState extends ConsumerState<AccountSignUpSteps> {
  final TextEditingController _email = TextEditingController();
  final TextEditingController _code = TextEditingController();
  final TextEditingController _age = TextEditingController();
  ListenerGender? _gender;
  bool _hasConsent = false;

  AccountSignUpController get _controller => ref.read(accountSignUpProvider.notifier);

  @override
  void dispose() {
    _email.dispose();
    _code.dispose();
    _age.dispose();
    super.dispose();
  }

  void _back() {
    if (!_controller.goBack()) widget.onLeave();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(accountSignUpProvider);
    final words = AppLocalizations.of(context);
    final (heading, body, footer) = switch (state.step) {
      AccountSignUpStep.email => _emailStep(context, state, words),
      AccountSignUpStep.code => _codeStep(context, state, words),
      AccountSignUpStep.aboutYou => _aboutYouStep(context, state, words),
    };
    return PopScope<Object?>(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: AccountStepFrame(
        // A new frame for each step, so a step opens at its top rather than where the last one was scrolled to.
        key: ValueKey(state.step),
        exitButton: ScreenExitButton.back(label: words.backButton, onPressed: _back),
        heading: heading,
        body: body,
        footer: footer,
      ),
    );
  }

  // ---- step 1: the email ---------------------------------------------------------------------------------

  (String, List<Widget>, List<Widget>) _emailStep(BuildContext context, AccountSignUpState state, AppLocalizations words) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    return (
      widget.mode == AccountSignUpMode.create ? words.accountCreateHeading : words.accountSignInHeading,
      [
        Text(words.accountEmailExplanation, style: tokens.typeStyles.body.copyWith(color: tokens.colours.muted)),
        SizedBox(height: spacing.space5),
        TextField(
          controller: _email,
          autofocus: true,
          keyboardType: TextInputType.emailAddress,
          textInputAction: TextInputAction.done,
          autofillHints: const [AutofillHints.email],
          autocorrect: false,
          enableSuggestions: false,
          onChanged: (_) => _controller.clearProblem(),
          onSubmitted: (_) => unawaited(_controller.sendCode(_email.text)),
          decoration: InputDecoration(labelText: words.accountEmailLabel, border: const OutlineInputBorder()),
        ),
        _ProblemNote(problem: state.problem),
      ],
      [
        _MainButton(
          label: words.accountSendCodeButton,
          isBusy: state.isBusy,
          onPressed: () => unawaited(_controller.sendCode(_email.text)),
        ),
      ],
    );
  }

  // ---- step 2: the code ----------------------------------------------------------------------------------

  (String, List<Widget>, List<Widget>) _codeStep(BuildContext context, AccountSignUpState state, AppLocalizations words) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    return (
      words.accountCodeHeading,
      [
        Text(words.accountCodeSentTo(state.email), style: tokens.typeStyles.body.copyWith(color: tokens.colours.muted)),
        SizedBox(height: spacing.space5),
        TextField(
          controller: _code,
          autofocus: true,
          keyboardType: TextInputType.number,
          textInputAction: TextInputAction.done,
          autofillHints: const [AutofillHints.oneTimeCode],
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(AccountRules.codeLength)],
          textAlign: TextAlign.center,
          style: tokens.typeStyles.headline.copyWith(letterSpacing: spacing.space2),
          onChanged: (_) => _controller.clearProblem(),
          onSubmitted: (_) => unawaited(_controller.checkCode(_code.text)),
          decoration: InputDecoration(labelText: words.accountCodeLabel, border: const OutlineInputBorder(), counterText: ''),
        ),
        _ProblemNote(problem: state.problem),
        if (state.wasNewCodeSent && state.problem == null) ...[
          SizedBox(height: spacing.space3),
          Semantics(liveRegion: true, container: true, child: Text(words.accountNewCodeOnItsWay, style: tokens.typeStyles.body)),
        ],
        SizedBox(height: spacing.space3),
        _ResendCodeButton(
          availableAt: state.resendAvailableAt,
          isBusy: state.isBusy,
          onPressed: () => unawaited(_controller.resendCode()),
        ),
        TextButton(
          onPressed: state.isBusy ? null : _controller.useDifferentEmail,
          child: Text(words.accountUseDifferentEmailButton),
        ),
      ],
      [
        _MainButton(
          label: words.accountCheckCodeButton,
          isBusy: state.isBusy,
          onPressed: () => unawaited(_controller.checkCode(_code.text)),
        ),
      ],
    );
  }

  // ---- step 3: gender, age and consent -------------------------------------------------------------------

  (String, List<Widget>, List<Widget>) _aboutYouStep(BuildContext context, AccountSignUpState state, AppLocalizations words) {
    final tokens = context.lookUpTokens;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final ageText = _age.text;
    final age = AccountRules.readAge(ageText);
    final isFormComplete = _gender != null && age != null && AccountRules.isOldEnough(age) && _hasConsent;
    // Told while typing, before any round trip: not a number in range, or under the minimum.
    final String? localAgeNote = ageText.trim().isEmpty
        ? null
        : age == null
        ? words.accountProblemAgeNotValid
        : (AccountRules.isOldEnough(age) ? null : words.accountProblemTooYoung);
    return (
      words.accountAboutYouHeading,
      [
        Text(words.accountAboutYouExplanation, style: typeStyles.body.copyWith(color: tokens.colours.muted)),
        SizedBox(height: spacing.space5),
        Semantics(header: true, child: Text(words.accountGenderLabel, style: typeStyles.body.copyWith(fontWeight: FontWeight.w700))),
        SizedBox(height: spacing.space2),
        Wrap(
          spacing: spacing.space2,
          runSpacing: spacing.space2,
          children: [
            for (final gender in ListenerGender.values)
              ChoiceChip(
                label: Text(_genderWords(gender, words)),
                selected: _gender == gender,
                onSelected: (_) {
                  _controller.clearProblem();
                  setState(() => _gender = gender);
                },
              ),
          ],
        ),
        SizedBox(height: spacing.space5),
        TextField(
          controller: _age,
          keyboardType: TextInputType.number,
          textInputAction: TextInputAction.done,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(2)],
          onChanged: (_) {
            _controller.clearProblem();
            setState(() {});
          },
          decoration: InputDecoration(
            labelText: words.accountAgeLabel,
            helperText: words.accountAgeHelp(AccountRules.minimumAge, AccountRules.maximumAge),
            border: const OutlineInputBorder(),
          ),
        ),
        if (localAgeNote != null) ...[
          SizedBox(height: spacing.space2),
          _Note(text: localAgeNote),
        ],
        SizedBox(height: spacing.space4),
        CheckboxListTile(
          value: _hasConsent,
          onChanged: (value) {
            _controller.clearProblem();
            setState(() => _hasConsent = value ?? false);
          },
          controlAffinity: ListTileControlAffinity.leading,
          contentPadding: EdgeInsets.zero,
          title: Text(words.accountConsentLabel, style: typeStyles.body),
        ),
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton(onPressed: () => unawaited(_showConsentSheet(context)), child: Text(words.accountConsentReadMoreButton)),
        ),
        // Beside the box it explains, not in the footer: the footer holds only the main button, so it stays small
        // enough to sit above the keyboard at large text on a small phone.
        if (!_hasConsent)
          Padding(
            padding: EdgeInsets.only(top: spacing.space2),
            child: Text(words.accountConsentNeeded, style: typeStyles.caption.copyWith(color: tokens.colours.muted)),
          ),
        _ProblemNote(problem: state.problem),
      ],
      [
        _MainButton(
          label: words.accountCreateButton,
          isBusy: state.isBusy,
          isEnabled: isFormComplete,
          onPressed: () => unawaited(_controller.createAccount(gender: _gender, ageText: _age.text, hasConsent: _hasConsent)),
        ),
      ],
    );
  }

  static String _genderWords(ListenerGender gender, AppLocalizations words) => switch (gender) {
    ListenerGender.female => words.accountGenderFemale,
    ListenerGender.male => words.accountGenderMale,
    ListenerGender.another => words.accountGenderAnother,
    ListenerGender.preferNotToSay => words.accountGenderPreferNotToSay,
  };

  /// "How we use this": the longer explanation, over the step. It slides in over motion.slow and out over motion.base,
  /// at once when the phone asks for less motion.
  Future<void> _showConsentSheet(BuildContext context) {
    final tokens = context.lookUpTokens;
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      backgroundColor: tokens.colours.surface,
      sheetAnimationStyle: MediaQuery.disableAnimationsOf(context)
          ? AnimationStyle.noAnimation
          : AnimationStyle(duration: tokens.motion.slow, reverseDuration: tokens.motion.base),
      builder: (sheetContext) {
        final words = AppLocalizations.of(sheetContext);
        final spacing = tokens.spacing;
        return SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(spacing.space6, 0, spacing.space6, spacing.space6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(header: true, child: Text(words.accountConsentSheetHeading, style: tokens.typeStyles.heading)),
              SizedBox(height: spacing.space3),
              Text(words.accountConsentSheetBody, style: tokens.typeStyles.body),
              SizedBox(height: spacing.space5),
              FilledButton(onPressed: () => Navigator.of(sheetContext).pop(), child: Text(words.closeButton)),
            ],
          ),
        );
      },
    );
  }
}

/// A step's one main button, full width and pinned above the keyboard by the frame. While a call is under way it
/// waits and shows a small spinner beside its words.
class _MainButton extends StatelessWidget {
  const _MainButton({required this.label, required this.isBusy, required this.onPressed, this.isEnabled = true});

  final String label;
  final bool isBusy;
  final bool isEnabled;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    return FilledButton(
      onPressed: isBusy || !isEnabled ? null : onPressed,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (isBusy) ...[
            SizedBox.square(
              dimension: tokens.spacing.space5,
              child: ExcludeSemantics(child: CircularProgressIndicator(strokeWidth: 2.5, color: tokens.colours.muted)),
            ),
            SizedBox(width: tokens.spacing.space2),
          ],
          // Flexible, so large text on a narrow phone wraps the words instead of running off the button.
          Flexible(child: Text(label, textAlign: TextAlign.center)),
        ],
      ),
    );
  }
}

/// What is wrong with the step, in the app's own words, announced when it appears; nothing when all is well.
class _ProblemNote extends StatelessWidget {
  const _ProblemNote({required this.problem});

  final AccountProblem? problem;

  @override
  Widget build(BuildContext context) {
    final problem = this.problem;
    if (problem == null) return const SizedBox.shrink();
    return Padding(
      padding: EdgeInsets.only(top: context.lookUpTokens.spacing.space3),
      child: _Note(text: AccountProblemWords.of(problem, AppLocalizations.of(context))),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    return Semantics(
      liveRegion: true,
      container: true,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ExcludeSemantics(child: Icon(Icons.error_outline, size: tokens.spacing.space5, color: tokens.colours.danger)),
          SizedBox(width: tokens.spacing.space2),
          Expanded(child: Text(text, style: tokens.typeStyles.body.copyWith(color: tokens.colours.danger))),
        ],
      ),
    );
  }
}

/// "Send a new code", which waits out the minute the server asks for and counts it down.
class _ResendCodeButton extends ConsumerStatefulWidget {
  const _ResendCodeButton({required this.availableAt, required this.isBusy, required this.onPressed});

  final DateTime? availableAt;
  final bool isBusy;
  final VoidCallback onPressed;

  @override
  ConsumerState<_ResendCodeButton> createState() => _ResendCodeButtonState();
}

class _ResendCodeButtonState extends ConsumerState<_ResendCodeButton> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final words = AppLocalizations.of(context);
    final availableAt = widget.availableAt;
    final millisecondsLeft = availableAt == null ? 0 : availableAt.difference(ref.read(accountClockProvider).now()).inMilliseconds;
    final secondsLeft = millisecondsLeft <= 0 ? 0 : (millisecondsLeft / 1000).ceil();
    return TextButton(
      onPressed: widget.isBusy || secondsLeft > 0 ? null : widget.onPressed,
      child: Text(secondsLeft > 0 ? words.accountResendCodeWait(secondsLeft) : words.accountResendCodeButton),
    );
  }
}
