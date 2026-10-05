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
  StreamSubscription<Amplitude>? _levelSubscription;
  StreamSubscription<void>? _playbackCompleteSubscription;
  Completer<void>? _cancelSignal;

  CaptureSettings _settings = const CaptureSettings();
  int _selectedTabIndex = 0;
  List<SessionStore> _sessions = []; // newest first; [0] is the current session
  Map<String, List<LabelledClip>> _clipsBySessionName = {};
  String? _playingPath;

  bool _isRecording = false;
  int _currentTakeNumber = 0;
  double _secondsLeft = 0;
  double _levelDecibelsFullScale = -60;
  double _peakDecibelsFullScale = -160;
  String? _lastResultMessage;
  bool _isLastResultSuccessful = true;

  SessionStore? get _currentSession => _sessions.isEmpty ? null : _sessions.first;
  int get _currentSessionClipCount =>
      _currentSession == null ? 0 : (_clipsBySessionName[_currentSession!.name]?.length ?? 0);

  @override
  void initState() {
    super.initState();
    _levelSubscription = _recorder.onAmplitudeChanged(const Duration(milliseconds: 100)).listen((amplitude) {
      if (!mounted) return;
      setState(() {
        _levelDecibelsFullScale = amplitude.current;
        _peakDecibelsFullScale = math.max(_peakDecibelsFullScale, amplitude.current);
      });
    });
    _playbackCompleteSubscription = _player.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _playingPath = null);
    });
    _reloadSessions();
  }

  @override
  void dispose() {
    _levelSubscription?.cancel();
    _playbackCompleteSubscription?.cancel();
    _player.dispose();
    _recorder.dispose();
    super.dispose();
  }

  Future<void> _reloadSessions() async {
    final sessions = await SessionStore.listAll();
    final clipsBySessionName = {for (final session in sessions) session.name: await session.listLabelledClips()};
    if (mounted) {
      setState(() {
        _sessions = sessions;
        _clipsBySessionName = clipsBySessionName;
      });
    }
  }

  void _updateSettings(CaptureSettings nextSettings) => setState(() => _settings = nextSettings);

  void _showMessage(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  // ---------------------------------------------------------------- recording

  Future<void> _record() async {
    final problem = _settings.validate();
    if (problem != null) return _showMessage(problem);
    if (!await _recorder.hasPermission()) {
      return _showMessage('Look Up Capture needs the microphone. Allow it in the phone settings.');
    }
    if (!await _recorder.isEncoderSupported(AudioEncoder.aacLc)) {
      return _showMessage('This phone cannot record AAC, so it cannot be used for this test.');
    }
    await _stopPlayback();
    final session = _currentSession ?? await SessionStore.create(DateTime.now());
    final settings = _settings; // freeze the settings for this run
    setState(() {
      _isRecording = true;
      _lastResultMessage = null;
    });
    final warnings = <String>[];
    var savedCount = 0;
    try {
      for (var takeNumber = 1; takeNumber <= settings.takeCount; takeNumber++) {
        final recordedAt = DateTime.now();
        final fileStem = settings.buildFileStem(recordedAt, takeNumber);
        _peakDecibelsFullScale = -160;
        _cancelSignal = Completer<void>();
        await _recorder.start(settings.toRecordConfig(), path: session.buildClipPath(fileStem));
        final stopwatch = Stopwatch()..start();
        final countdownTimer = Timer.periodic(const Duration(milliseconds: 200), (_) {
          if (!mounted) return;
          setState(() {
            _currentTakeNumber = takeNumber;
            _secondsLeft = math.max(0, settings.clipSeconds - stopwatch.elapsedMilliseconds / 1000);
          });
        });
        await Future.any([Future<void>.delayed(Duration(seconds: settings.clipSeconds)), _cancelSignal!.future]);
        countdownTimer.cancel();
        final recordedPath = await _recorder.stop();
        if (_cancelSignal!.isCompleted) {
          if (recordedPath != null && await File(recordedPath).exists()) await File(recordedPath).delete(); // never keep a half clip
          warnings.add('Cancelled — the unfinished clip was deleted.');
          break;
        }
        await session.appendManifestRow(settings.buildManifestRow('$fileStem.m4a', recordedAt));
        savedCount++;
        if (_peakDecibelsFullScale > -1) warnings.add('Take $takeNumber was very loud (possible distortion).');
        if (_peakDecibelsFullScale < -45) warnings.add('Take $takeNumber was very quiet — is the microphone covered?');
      }
    } catch (error) {
      warnings.add('Recording stopped on this phone (${error.runtimeType}). Try another microphone source.');
    } finally {
      await _reloadSessions();
      if (mounted) {
        setState(() {
          _isRecording = false;
          _isLastResultSuccessful = savedCount > 0;
          _lastResultMessage = [
            if (savedCount > 0) 'Saved $savedCount clip${savedCount == 1 ? '' : 's'} to this session.',
            ...warnings,
          ].join('\n');
        });
      }
    }
  }

  void _cancelRecording() => _cancelSignal?.complete();

  // ---------------------------------------------------------------- playback

  Future<void> _togglePlayback(LabelledClip clip) async {
    final path = clip.file.path;
    if (_playingPath == path) return _stopPlayback();
    try {
      await _player.stop();
      await _player.play(DeviceFileSource(path));
      setState(() => _playingPath = path);
    } catch (error) {
      setState(() => _playingPath = null);
      _showMessage('This clip could not be played on this phone (${error.runtimeType}).');
    }
  }

  Future<void> _stopPlayback() async {
    if (_playingPath == null) return;
    await _player.stop();
    if (mounted) setState(() => _playingPath = null);
  }

  // ---------------------------------------------------------------- session actions

  Future<void> _sendSession(SessionStore session) async {
    final clips = _clipsBySessionName[session.name] ?? [];
    if (clips.isEmpty) return _showMessage('There are no recordings in this session yet.');
    await SharePlus.instance.share(ShareParams(
      files: [...clips.map((clip) => XFile(clip.file.path)), XFile(session.manifest.path)],
      text: 'Look Up test recordings — ${session.name} — ${clips.length} clips plus manifest.part.csv',
    ));
  }

  Future<void> _deleteClip(SessionStore session, LabelledClip clip) async {
    final isConfirmed = await showDialog<bool>(
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
    if (isConfirmed != true) return;
    if (_playingPath == clip.file.path) await _stopPlayback();
    await session.deleteClip(clip.file);
    await _reloadSessions();
    _showMessage('Recording deleted.');
  }

  Future<void> _startNewSession() async {
    final isConfirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Start a new session?'),
        content: Text('The $_currentSessionClipCount recording${_currentSessionClipCount == 1 ? '' : 's'} you have now stay saved. '
            'New recordings go into a fresh session.\n\n'
            'Start a new session when you change place, day or phone, so each batch you send is easy to keep apart.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Not now')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Start new session')),
        ],
      ),
    );
    if (isConfirmed != true) return;
    await SessionStore.create(DateTime.now());
    await _reloadSessions();
    _showMessage('New session started. Your earlier recordings are under "Earlier sessions".');
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
        absorbing: _isRecording,
        child: IndexedStack(index: _selectedTabIndex, children: [_buildRecordTab(context), _buildRecordingsTab(context)]),
      ),
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_selectedTabIndex == 0)
            SafeArea(
              top: false,
              bottom: false,
              minimum: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              child: _isRecording
                  ? _RecordingBar(
                      takeNumber: _currentTakeNumber,
                      takeCount: _settings.takeCount,
                      secondsLeft: _secondsLeft,
                      levelDecibelsFullScale: _levelDecibelsFullScale,
                      onCancel: _cancelRecording,
                    )
                  : FilledButton.icon(
                      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                      onPressed: _record,
                      icon: const Icon(Icons.mic),
                      label: Text('Record ${_settings.takeCount == 1 ? '' : '${_settings.takeCount} × '}${_settings.clipSeconds} s'),
                    ),
            ),
          NavigationBar(
            selectedIndex: _selectedTabIndex,
            onDestinationSelected: _isRecording ? null : (index) => setState(() => _selectedTabIndex = index),
            destinations: [
              const NavigationDestination(icon: Icon(Icons.mic_none), selectedIcon: Icon(Icons.mic), label: 'Record'),
              NavigationDestination(
                icon: Badge(
                  isLabelVisible: _currentSessionClipCount > 0,
                  label: Text('$_currentSessionClipCount'),
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

  Widget _buildRecordTab(BuildContext context) {
    final settings = _settings;
    final theme = Theme.of(context);
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        if (_lastResultMessage != null)
          Card(
            color: _isLastResultSuccessful ? theme.colorScheme.secondaryContainer : theme.colorScheme.errorContainer,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_lastResultMessage!, style: theme.textTheme.bodyLarge),
                  if (_isLastResultSuccessful)
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton.icon(
                        onPressed: () => setState(() => _selectedTabIndex = 1),
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
            enabled: !settings.isNegative,
            decoration: const InputDecoration(labelText: 'Ad id (as in the manifest)', hintText: 'e.g. brand-a-summer'),
            onChanged: (text) => _updateSettings(settings.copyWith(adId: text)),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Not an ad (music, talk, other)'),
            subtitle: const Text('Saved as a negative clip'),
            value: settings.isNegative,
            onChanged: (isOn) => _updateSettings(settings.copyWith(isNegative: isOn)),
          ),
        ]),
        _Section('Where', [
          TextField(
            decoration: const InputDecoration(labelText: 'Phone model and Android version', hintText: 'e.g. itel-a70-a13'),
            onChanged: (text) => _updateSettings(settings.copyWith(device: text)),
          ),
          const SizedBox(height: 12),
          _ChoiceChipGroup<String>(
            values: scenes,
            selectedValue: settings.scene,
            labelFor: (scene) => scene,
            onSelected: (scene) => _updateSettings(settings.copyWith(scene: scene)),
          ),
        ]),
        _Section('Clip', [
          _ChoiceChipGroup<int>(
            values: clipLengthsSeconds,
            selectedValue: settings.clipSeconds,
            labelFor: (seconds) => '$seconds s',
            onSelected: (seconds) => _updateSettings(settings.copyWith(clipSeconds: seconds)),
          ),
          const SizedBox(height: 8),
          _ChoiceChipGroup<int>(
            values: const [1, 2, 3],
            selectedValue: settings.takeCount,
            labelFor: (takeCount) => takeCount == 1 ? '1 take' : '$takeCount takes in a row',
            onSelected: (takeCount) => _updateSettings(settings.copyWith(takeCount: takeCount)),
          ),
          const SizedBox(height: 8),
          _ChoiceChipGroup<int>(
            values: bitRatesBitsPerSecond,
            selectedValue: settings.bitRate,
            labelFor: (bitRate) => 'AAC ${bitRate ~/ 1000} kbps',
            onSelected: (bitRate) => _updateSettings(settings.copyWith(bitRate: bitRate)),
          ),
        ]),
        _Section('Microphone settings', [
          _ChoiceChipGroup<AndroidAudioSource>(
            values: audioSources,
            selectedValue: settings.audioSource,
            labelFor: (audioSource) => audioSource.name,
            onSelected: (audioSource) => _updateSettings(settings.copyWith(audioSource: audioSource)),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Noise suppression'),
            value: settings.noiseSuppress,
            onChanged: (isOn) => _updateSettings(settings.copyWith(noiseSuppress: isOn)),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Auto gain'),
            value: settings.autoGain,
            onChanged: (isOn) => _updateSettings(settings.copyWith(autoGain: isOn)),
          ),
          Text('Saved as: ${settings.codecLabel} · 16 kHz mono · ${settings.microphoneSettingsLabel}',
              style: theme.textTheme.bodySmall),
        ]),
      ],
    );
  }

  Widget _buildRecordingsTab(BuildContext context) {
    final theme = Theme.of(context);
    final currentSession = _currentSession;
    if (currentSession == null || (_sessions.length == 1 && _currentSessionClipCount == 0)) {
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
              FilledButton.tonal(onPressed: () => setState(() => _selectedTabIndex = 0), child: const Text('Go to Record')),
            ],
          ),
        ),
      );
    }
    final earlierSessions =
        _sessions.skip(1).where((session) => (_clipsBySessionName[session.name] ?? []).isNotEmpty).toList();
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('Current session · $_currentSessionClipCount recording${_currentSessionClipCount == 1 ? '' : 's'}',
                    style: theme.textTheme.titleMedium),
                const SizedBox(height: 4),
                Text('Started ${_formatSessionTime(currentSession.startedAt)}. A session is one batch you send to the computer together.',
                    style: theme.textTheme.bodySmall),
                const SizedBox(height: 12),
                FilledButton.icon(
                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                  onPressed: _currentSessionClipCount == 0 ? null : () => _sendSession(currentSession),
                  icon: const Icon(Icons.send),
                  label: const Text('Send to computer'),
                ),
                const SizedBox(height: 4),
                Text('Opens WhatsApp, Drive, email… It sends the clips plus manifest.part.csv (their labels). '
                    'Save them all in one folder on the computer.', style: theme.textTheme.bodySmall),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                  onPressed: _startNewSession,
                  icon: const Icon(Icons.create_new_folder_outlined),
                  label: const Text('Start new session'),
                ),
              ],
            ),
          ),
        ),
        for (final clip in _clipsBySessionName[currentSession.name] ?? const <LabelledClip>[])
          _buildClipTile(currentSession, clip),
        if (earlierSessions.isNotEmpty) ...[
          const SizedBox(height: 16),
          Text('Earlier sessions', style: theme.textTheme.titleSmall),
          for (final session in earlierSessions)
            Card(
              child: ExpansionTile(
                title: Text('${_formatSessionTime(session.startedAt)} · ${_clipsBySessionName[session.name]!.length} recordings'),
                childrenPadding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                children: [
                  for (final clip in _clipsBySessionName[session.name]!) _buildClipTile(session, clip),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton.icon(
                        onPressed: () => _sendSession(session), icon: const Icon(Icons.send), label: const Text('Send this session')),
                  ),
                ],
              ),
            ),
        ],
      ],
    );
  }

  Widget _buildClipTile(SessionStore session, LabelledClip clip) {
    final isPlaying = _playingPath == clip.file.path;
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 4),
      leading: IconButton.filledTonal(
        tooltip: isPlaying ? 'Stop' : 'Play',
        iconSize: 28,
        onPressed: () => _togglePlayback(clip),
        icon: Icon(isPlaying ? Icons.stop : Icons.play_arrow),
      ),
      title: Text(clip.title),
      subtitle: Text(isPlaying ? 'Playing…' : clip.details),
      trailing: IconButton(
        tooltip: 'Delete',
        onPressed: () => _deleteClip(session, clip),
        icon: const Icon(Icons.delete_outline),
      ),
    );
  }

  static String _formatSessionTime(DateTime? time) {
    if (time == null) return 'earlier';
    String twoDigits(int number) => number.toString().padLeft(2, '0');
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${time.day} ${monthNames[time.month - 1]}, ${twoDigits(time.hour)}:${twoDigits(time.minute)}';
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

class _ChoiceChipGroup<T> extends StatelessWidget {
  const _ChoiceChipGroup({
    required this.values,
    required this.selectedValue,
    required this.labelFor,
    required this.onSelected,
  });

  final List<T> values;
  final T selectedValue;
  final String Function(T) labelFor;
  final ValueChanged<T> onSelected;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final value in values)
          ChoiceChip(label: Text(labelFor(value)), selected: value == selectedValue, onSelected: (_) => onSelected(value)),
      ],
    );
  }
}

class _RecordingBar extends StatelessWidget {
  const _RecordingBar({
    required this.takeNumber,
    required this.takeCount,
    required this.secondsLeft,
    required this.levelDecibelsFullScale,
    required this.onCancel,
  });

  final int takeNumber;
  final int takeCount;
  final double secondsLeft;
  final double levelDecibelsFullScale;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final levelFraction = ((levelDecibelsFullScale + 60) / 60).clamp(0.0, 1.0);
    return Row(
      children: [
        Expanded(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Recording take $takeNumber of $takeCount · ${secondsLeft.toStringAsFixed(1)} s left',
                  style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: 8),
              Semantics(
                label: 'Microphone level',
                child: LinearProgressIndicator(value: levelFraction, minHeight: 10, borderRadius: BorderRadius.circular(5)),
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        OutlinedButton(
          style: OutlinedButton.styleFrom(minimumSize: const Size(88, 56)),
          onPressed: onCancel,
          child: const Text('Cancel'),
        ),
      ],
    );
  }
}
