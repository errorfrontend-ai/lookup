import 'dart:async';
import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lookup_listener/core/theme/look_up_tokens.dart';
import 'package:lookup_listener/features/identify/presentation/how_it_works_note.dart';
import 'package:lookup_listener/l10n/app_localizations.dart';

/// Home's first-open note, "How Look Up works" (P6 design §2.3, Q20 as the user answered it on
/// 11 October 2026; ALL-USABILITY-04): a card under the header with an info icon, the title, what
/// identifying does and what History is for, and "Got it".
///
/// It records itself as shown once it has been drawn ([HowItWorksNote.markShown]), so no later
/// launch shows it, and "Got it" hides it for the rest of this launch. Screen readers meet it as
/// one region named by its title. The words are the user's approved wording.
class HowItWorksNoteCard extends ConsumerStatefulWidget {
  const HowItWorksNoteCard({super.key});

  @override
  ConsumerState<HowItWorksNoteCard> createState() => _HowItWorksNoteCardState();
}

class _HowItWorksNoteCardState extends ConsumerState<HowItWorksNoteCard> {
  @override
  void initState() {
    super.initState();
    // Drawn once is shown: a later launch never shows it, whether or not "Got it" is tapped.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(ref.read(howItWorksNoteProvider.notifier).markShown());
    });
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.lookUpTokens;
    final colours = tokens.colours;
    final spacing = tokens.spacing;
    final typeStyles = tokens.typeStyles;
    final words = AppLocalizations.of(context);
    final mutedCaption = typeStyles.caption.copyWith(color: colours.muted);
    final shape = BorderRadius.circular(tokens.radii.large);
    return Semantics(
      container: true,
      role: SemanticsRole.region,
      label: words.howItWorksTitle,
      explicitChildNodes: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colours.surface,
          borderRadius: shape,
          border: Border.all(color: colours.lineSoft),
        ),
        child: Padding(
          padding: EdgeInsets.fromLTRB(
            spacing.space4,
            spacing.space4,
            spacing.space4,
            spacing.space2,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Decorative: the title says what the card is.
                  ExcludeSemantics(
                    child: Icon(Icons.info_outline, size: spacing.space6, color: colours.accent),
                  ),
                  SizedBox(width: spacing.space3),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Semantics(
                          header: true,
                          child: Text(
                            words.howItWorksTitle,
                            style: typeStyles.body.copyWith(fontWeight: FontWeight.w700),
                          ),
                        ),
                        SizedBox(height: spacing.space1),
                        Text(words.howItWorksIdentify, style: mutedCaption),
                        SizedBox(height: spacing.space1),
                        Text(words.howItWorksHistory, style: mutedCaption),
                      ],
                    ),
                  ),
                ],
              ),
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: TextButton(
                  onPressed: ref.read(howItWorksNoteProvider.notifier).dismiss,
                  style: TextButton.styleFrom(foregroundColor: colours.accent),
                  child: Text(words.gotItButton),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
