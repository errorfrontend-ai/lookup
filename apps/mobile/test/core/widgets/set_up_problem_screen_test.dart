import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lookup_listener/core/configuration/configuration_problem.dart';
import 'package:lookup_listener/core/widgets/set_up_problem_screen.dart';

import '../../support/expect_no_technical_text.dart';
import '../../support/phone_screen.dart';
import '../../support/english_words.dart';

const List<ConfigurationProblem> _problems = [
  ConfigurationProblem.apiBaseUrlNotHttps,
  ConfigurationProblem.gradleFlavourDiffers,
];

void main() {
  testWidgets('says the copy is not set up correctly, as a heading, and nothing technical', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await PhoneScreen.standard.pump(tester, const SetUpProblemScreen(problems: _problems));

    expect(find.text("This copy of Look Up isn't set up correctly."), findsOneWidget);
    expect(
      tester.getSemantics(find.text(englishWords.setUpProblemHeading)),
      matchesSemantics(label: englishWords.setUpProblemHeading, isHeader: true),
    );
    expect(find.text(englishWords.developmentOnlyDetails), findsNothing);
    for (final problem in _problems) {
      expect(find.text(SetUpProblemScreen.describe(problem, englishWords)), findsNothing);
    }
    expectNoTechnicalText(tester, alsoForbidden: ['LOOKUP_', 'https', 'flavour']);
    semantics.dispose();
  });

  testWidgets('offers no button: there is nowhere to go and nothing to send', (tester) async {
    await PhoneScreen.standard.pump(tester, const SetUpProblemScreen(problems: _problems));
    expect(find.byWidgetPredicate((widget) => widget is ButtonStyleButton), findsNothing);
    expect(find.byType(IconButton), findsNothing);
  });

  testWidgets('a development build also lists the problems for the developer', (tester) async {
    await PhoneScreen.standard.pump(
      tester,
      const SetUpProblemScreen(problems: _problems, showsProblems: true),
    );
    expect(find.text(englishWords.developmentOnlyDetails), findsOneWidget);
    for (final problem in _problems) {
      expect(find.text(SetUpProblemScreen.describe(problem, englishWords)), findsOneWidget);
    }
  });

  testWidgets('meets the contrast guideline', (tester) async {
    await PhoneScreen.standard.pump(
      tester,
      const SetUpProblemScreen(problems: _problems, showsProblems: true),
    );
    await expectLater(tester, meetsGuideline(textContrastGuideline));
  });

  for (final screen in PhoneScreen.layoutChecks) {
    testWidgets('fits on $screen, with every problem listed', (tester) async {
      await screen.pump(
        tester,
        const SetUpProblemScreen(problems: ConfigurationProblem.values, showsProblems: true),
      );
      expect(tester.takeException(), isNull);
      final lastProblem = find.text(
        SetUpProblemScreen.describe(ConfigurationProblem.values.last, englishWords),
      );
      await tester.ensureVisible(lastProblem);
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(tester.getRect(lastProblem).bottom, lessThanOrEqualTo(screen.height));
    });
  }
}
