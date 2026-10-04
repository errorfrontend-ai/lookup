import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:record/record.dart';
import 'package:share_plus/share_plus.dart';

import 'capture_settings.dart';
import 'session_store.dart';

/// Look Up — Phase 0 test recorder (not the Look Up listener app). Records test clips on real
/// phones with the exact encoder settings the listener app will ship, labelled for the benchmark.
void main() => runApp(const CaptureApp());

class CaptureApp extends StatelessWidget {
  const CaptureApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Look Up Capture',
      theme: ThemeData(colorSchemeSeed: const Color(0xFFA8431A), useMaterial3: true),
      darkTheme: ThemeData(
        colorSchemeSeed: const Color(0xFFA8431A),
        brightness: Brightness.dark,
        useMaterial3: true,
      ),
      home: const CaptureHome(),
    );
  }
}

class CaptureHome extends StatefulWidget {
  const CaptureHome({super.key});

  @override
  State<CaptureHome> createState() => _CaptureHomeState();
}

class _CaptureHomeState extends State<CaptureHome> {
  final _recorder = AudioRecorder();
  final _player = AudioPlayer();
  StreamSubscription<Amplitude>? _levels;
  StreamSubscription<void>? _playerDone;
  Completer<void>? _cancel;

  CaptureSettings _settings = const CaptureSettings();
  int _tab = 0;
  List<SessionStore> _sessions = []; // newest first; [0] is the current session
  Map<String, List<ClipInfo>> _clips = {};
  String? _playing;

  bool _recording = false;
  int _take = 0;
  double _secondsLeft = 0;
  double _level = -60; // dBFS
  double _peak = -160;
  String? _lastResult;
  bool _lastResultOk = true;

  SessionStore? get _current => _sessions.isEmpty ? null : _sessions.first;
  int get _currentCount => _current == null ? 0 : (_clips[_current!.name]?.length ?? 0);

  @override
  void initState() {
    super.initState();
    _levels = _recorder.onAmplitudeChanged(const Duration(milliseconds: 100)).listen((a) {
      if (!mounted) return;
      setState(() {
        _level = a.current;
        _peak = math.max(_peak, a.current);
      });
    });
    _playerDone = _player.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _playing = null);
    });
    _reload();
  }

  @override
  void dispose() {
    _levels?.cancel();
    _playerDone?.cancel();
    _player.dispose();
    _recorder.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    final sessions = await SessionStore.all();
    final clips = {for (final s in sessions) s.name: await s.clipInfos()};
    if (mounted) {
      setState(() {
        _sessions = sessions;
        _clips = clips;
      });
    }
  }

  void _update(CaptureSettings next) => setState(() => _settings = next);

  void _say(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  // ---------------------------------------------------------------- recording

  Future<void> _record() async {
    final problem = _settings.validate();
    if (problem != null) return _say(problem);
    if (!await _recorder.hasPermission()) {
      return _say('Look Up Capture needs the microphone. Allow it in the phone settings.');
    }
    if (!await _recorder.isEncoderSupported(AudioEncoder.aacLc)) {
      return _say('This phone cannot record AAC, so it cannot be used for this test.');
    }
    await _stopPlayback();
    final store = _current ?? await SessionStore.create(DateTime.now());
    final settings = _settings; // freeze the settings for this run
    setState(() {
      _recording = true;
      _lastResult = null;
    });
    final warnings = <String>[];
    var saved = 0;
    try {
      for (var take = 1; take <= settings.takes; take++) {
        final at = DateTime.now();
        final stem = settings.fileStem(at, take);
        _peak = -160;
        _cancel = Completer<void>();
        await _recorder.start(settings.toRecordConfig(), path: store.pathFor(stem));
        final clock = Stopwatch()..start();
        final ticker = Timer.periodic(const Duration(milliseconds: 200), (_) {
          if (!mounted) return;
          setState(() {
            _take = take;
            _secondsLeft = math.max(0, settings.clipSeconds - clock.elapsedMilliseconds / 1000);
          });
        });
        await Future.any([Future<void>.delayed(Duration(seconds: settings.clipSeconds)), _cancel!.future]);
        ticker.cancel();
        final path = await _recorder.stop();
        if (_cancel!.isCompleted) {
          if (path != null && await File(path).exists()) await File(path).delete(); // never keep a half clip
          warnings.add('Cancelled — the unfinished clip was deleted.');
          break;
        }
        await store.addRow(settings.manifestRow('$stem.m4a', at));
        saved++;
        if (_peak > -1) warnings.add('Take $take was very loud (possible distortion).');
        if (_peak < -45) warnings.add('Take $take was very quiet — is the microphone covered?');
      }
    } catch (error) {
      warnings.add('Recording stopped on this phone (${error.runtimeType}). Try another microphone source.');
    } finally {
      await _reload();
      if (mounted) {
        setState(() {
          _recording = false;
          _lastResultOk = saved > 0;
          _lastResult = [
            if (saved > 0) 'Saved $saved clip${saved == 1 ? '' : 's'} to this session.',
            ...warnings,
          ].join('\n');
        });
      }
    }
  }

  void _stop() => _cancel?.complete();

  // ---------------------------------------------------------------- playback

  Future<void> _togglePlay(ClipInfo clip) async {
    final path = clip.file.path;
    if (_playing == path) return _stopPlayback();
    try {
      await _player.stop();
      await _player.play(DeviceFileSource(path));
      setState(() => _playing = path);
    } catch (error) {
      setState(() => _playing = null);
      _say('This clip could not be played on this phone (${error.runtimeType}).');
    }
  }

  Future<void> _stopPlayback() async {
    if (_playing == null) return;
    await _player.stop();
    if (mounted) setState(() => _playing = null);
  }

  // ---------------------------------------------------------------- session actions

  Future<void> _send(SessionStore session) async {
    final clips = _clips[session.name] ?? [];
    if (clips.isEmpty) return _say('There are no recordings in this session yet.');
    await SharePlus.instance.share(ShareParams(
      files: [...clips.map((c) => XFile(c.file.path)), XFile(session.manifest.path)],
      text: 'Look Up test recordings — ${session.name} — ${clips.length} clips plus manifest.part.csv',
    ));
  }

  Future<void> _delete(SessionStore session, ClipInfo clip) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this recording?'),
        content: Text('${clip.title}\n\nIt is removed from the phone and from this session\'s list. This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Keep it')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    if (_playing == clip.file.path) await _stopPlayback();
    await session.deleteClip(clip.file);
    await _reload();
    _say('Recording deleted.');
  }

  Future<void> _newSession() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Start a new session?'),
        content: Text('The $_currentCount recording${_currentCount == 1 ? '' : 's'} you have now stay saved. '
            'New recordings go into a fresh session.\n\n'
            'Start a new session when you change place, day or phone, so each batch you send is easy to keep apart.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Not now')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Start new session')),
        ],
      ),
    );
    if (ok != true) return;
    await SessionStore.create(DateTime.now());
    await _reload();
    _say('New session started. Your earlier recordings are under "Earlier sessions".');
  }

  // ---------------------------------------------------------------- UI

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Look Up Capture'),
        bottom: const PreferredSize(
          preferredSize: Size.fromHeight(20),
          child: Padding(
            padding: EdgeInsets.only(left: 16, bottom: 6),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('Test recorder — not the Look Up app itself'),
            ),
          ),
        ),
      ),
      body: AbsorbPointer(
        absorbing: _recording,
        child: IndexedStack(index: _tab, children: [_recordTab(context), _recordingsTab(context)]),
      ),
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_tab == 0)
            SafeArea(
              top: false,
              bottom: false,
              minimum: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              child: _recording
                  ? _RecordingBar(
                      take: _take,
                      takes: _settings.takes,
                      secondsLeft: _secondsLeft,
                      level: _level,
                      onStop: _stop,
                    )
                  : FilledButton.icon(
                      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                      onPressed: _record,
                      icon: const Icon(Icons.mic),
                      label: Text('Record ${_settings.takes == 1 ? '' : '${_settings.takes} × '}${_settings.clipSeconds} s'),
                    ),
            ),
          NavigationBar(
            selectedIndex: _tab,
            onDestinationSelected: _recording ? null : (i) => setState(() => _tab = i),
            destinations: [
              const NavigationDestination(icon: Icon(Icons.mic_none), selectedIcon: Icon(Icons.mic), label: 'Record'),
              NavigationDestination(
                icon: Badge(
                  isLabelVisible: _currentCount > 0,
                  label: Text('$_currentCount'),
                  child: const Icon(Icons.library_music_outlined),
                ),
                selectedIcon: const Icon(Icons.library_music),
                label: 'Recordings',
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _recordTab(BuildContext context) {
    final s = _settings;
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        if (_lastResult != null)
          Card(
            color: _lastResultOk ? theme.colorScheme.secondaryContainer : theme.colorScheme.errorContainer,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_lastResult!, style: theme.textTheme.bodyLarge),
                  if (_lastResultOk)
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton.icon(
                        onPressed: () => setState(() => _tab = 1),
                        icon: const Icon(Icons.play_circle_outline),
                        label: const Text('Listen to it'),
                      ),
                    ),
                ],
              ),
            ),
          )
        else
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                'How it works\n'
                '1. Fill in what is playing and where you are.\n'
                '2. Tap Record while the ad plays on the radio.\n'
                '3. Open Recordings (bottom right) to listen, then send them to the computer.',
                style: theme.textTheme.bodyMedium,
              ),
            ),
          ),
        _Section('What is playing', [
          TextField(
            enabled: !s.negative,
            decoration: const InputDecoration(labelText: 'Ad id (as in the manifest)', hintText: 'e.g. brand-a-summer'),
            onChanged: (v) => _update(s.copyWith(adId: v)),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Not an ad (music, talk, other)'),
            subtitle: const Text('Saved as a negative clip'),
            value: s.negative,
            onChanged: (v) => _update(s.copyWith(negative: v)),
          ),
        ]),
        _Section('Where', [
          TextField(
            decoration: const InputDecoration(labelText: 'Phone model and Android version', hintText: 'e.g. itel-a70-a13'),
            onChanged: (v) => _update(s.copyWith(device: v)),
          ),
          const SizedBox(height: 12),
          _Chips<String>(values: scenes, selected: s.scene, label: (v) => v, onSelected: (v) => _update(s.copyWith(scene: v))),
        ]),
        _Section('Clip', [
          _Chips<int>(values: clipLengths, selected: s.clipSeconds, label: (v) => '$v s', onSelected: (v) => _update(s.copyWith(clipSeconds: v))),
          const SizedBox(height: 8),
          _Chips<int>(values: const [1, 2, 3], selected: s.takes, label: (v) => v == 1 ? '1 take' : '$v takes in a row', onSelected: (v) => _update(s.copyWith(takes: v))),
          const SizedBox(height: 8),
          _Chips<int>(values: bitRates, selected: s.bitRate, label: (v) => 'AAC ${v ~/ 1000} kbps', onSelected: (v) => _update(s.copyWith(bitRate: v))),
        ]),
        _Section('Microphone settings', [
          _Chips<AndroidAudioSource>(values: audioSources, selected: s.audioSource, label: (v) => v.name, onSelected: (v) => _update(s.copyWith(audioSource: v))),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Noise suppression'),
            value: s.noiseSuppress,
            onChanged: (v) => _update(s.copyWith(noiseSuppress: v)),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Auto gain'),
            value: s.autoGain,
            onChanged: (v) => _update(s.copyWith(autoGain: v)),
          ),
          Text('Saved as: ${s.codecLabel} · 16 kHz mono · ${s.micLabel}', style: theme.textTheme.bodySmall),
        ]),
      ],
    );
  }

  Widget _recordingsTab(BuildContext context) {
    final theme = Theme.of(context);
    final current = _current;
    if (current == null || (_sessions.length == 1 && _currentCount == 0)) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.library_music_outlined, size: 56, color: theme.colorScheme.outline),
              const SizedBox(height: 16),
              Text('No recordings yet', style: theme.textTheme.titleLarge),
              const SizedBox(height: 8),
              const Text(
                'Go to Record, fill in what is playing and where, then tap Record while the ad plays. '
                'Your clips appear here to listen to and send.',
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              FilledButton.tonal(onPressed: () => setState(() => _tab = 0), child: const Text('Go to Record')),
            ],
          ),
        ),
      );
    }
    final earlier = _sessions.skip(1).where((s) => (_clips[s.name] ?? []).isNotEmpty).toList();
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('Current session · $_currentCount recording${_currentCount == 1 ? '' : 's'}', style: theme.textTheme.titleMedium),
                const SizedBox(height: 4),
                Text('Started ${_when(current.startedAt)}. A session is one batch you send to the computer together.',
                    style: theme.textTheme.bodySmall),
                const SizedBox(height: 12),
                FilledButton.icon(
                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                  onPressed: _currentCount == 0 ? null : () => _send(current),
                  icon: const Icon(Icons.send),
                  label: const Text('Send to computer'),
                ),
                const SizedBox(height: 4),
                Text('Opens WhatsApp, Drive, email… It sends the clips plus manifest.part.csv (their labels). '
                    'Save them all in one folder on the computer.', style: theme.textTheme.bodySmall),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                  onPressed: _newSession,
                  icon: const Icon(Icons.create_new_folder_outlined),
                  label: const Text('Start new session'),
                ),
              ],
            ),
          ),
        ),
        for (final clip in _clips[current.name] ?? const <ClipInfo>[]) _clipTile(current, clip),
        if (earlier.isNotEmpty) ...[
          const SizedBox(height: 16),
          Text('Earlier sessions', style: theme.textTheme.titleSmall),
          for (final s in earlier)
            Card(
              child: ExpansionTile(
                title: Text('${_when(s.startedAt)} · ${_clips[s.name]!.length} recordings'),
                childrenPadding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                children: [
                  for (final clip in _clips[s.name]!) _clipTile(s, clip),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton.icon(onPressed: () => _send(s), icon: const Icon(Icons.send), label: const Text('Send this session')),
                  ),
                ],
              ),
            ),
        ],
      ],
    );
  }

  Widget _clipTile(SessionStore session, ClipInfo clip) {
    final playing = _playing == clip.file.path;
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 4),
      leading: IconButton.filledTonal(
        tooltip: playing ? 'Stop' : 'Play',
        iconSize: 28,
        onPressed: () => _togglePlay(clip),
        icon: Icon(playing ? Icons.stop : Icons.play_arrow),
      ),
      title: Text(clip.title),
      subtitle: Text(playing ? 'Playing…' : clip.details),
      trailing: IconButton(
        tooltip: 'Delete',
        onPressed: () => _delete(session, clip),
        icon: const Icon(Icons.delete_outline),
      ),
    );
  }

  static String _when(DateTime? t) {
    if (t == null) return 'earlier';
    String two(int n) => n.toString().padLeft(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${t.day} ${months[t.month - 1]}, ${two(t.hour)}:${two(t.minute)}';
  }
}

class _Section extends StatelessWidget {
  const _Section(this.title, this.children);

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 4),
          ...children,
        ],
      ),
    );
  }
}

class _Chips<T> extends StatelessWidget {
  const _Chips({required this.values, required this.selected, required this.label, required this.onSelected});

  final List<T> values;
  final T selected;
  final String Function(T) label;
  final ValueChanged<T> onSelected;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final v in values)
          ChoiceChip(label: Text(label(v)), selected: v == selected, onSelected: (_) => onSelected(v)),
      ],
    );
  }
}

class _RecordingBar extends StatelessWidget {
  const _RecordingBar({
    required this.take,
    required this.takes,
    required this.secondsLeft,
    required this.level,
    required this.onStop,
  });

  final int take;
  final int takes;
  final double secondsLeft;
  final double level;
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final fill = ((level + 60) / 60).clamp(0.0, 1.0);
    return Row(
      children: [
        Expanded(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Recording take $take of $takes · ${secondsLeft.toStringAsFixed(1)} s left',
                  style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: 8),
              Semantics(
                label: 'Microphone level',
                child: LinearProgressIndicator(value: fill, minHeight: 10, borderRadius: BorderRadius.circular(5)),
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        OutlinedButton(
          style: OutlinedButton.styleFrom(minimumSize: const Size(88, 56)),
          onPressed: onStop,
          child: const Text('Cancel'),
        ),
      ],
    );
  }
}
