import 'package:flutter/widgets.dart';

/// Whether ad pictures (banners, logos) may be downloaded now (P6 design §3.16; P6-DATASAVER-05,
/// -06): false only with "Load ad pictures on mobile data" off on a metered network. The app sets
/// it once, above every screen; each picture asks it, so with it false no picture is requested and
/// logos show their initials. Where none is set, pictures load.
class PicturesAllowed extends InheritedWidget {
  const PicturesAllowed({super.key, required this.mayLoad, required super.child});

  final bool mayLoad;

  static bool of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<PicturesAllowed>()?.mayLoad ?? true;

  @override
  bool updateShouldNotify(PicturesAllowed oldWidget) => oldWidget.mayLoad != mayLoad;
}
