// The app side of push-to-talk: page message -> mic -> on-device STT -> transcript events back to the page.
// No Flutter imports: the WebView, the mic and the recogniser are injected, so the whole flow is unit-tested.

import 'dart:async';

import '../audio/mic.dart';
import '../stt/hotwords.dart';
import '../stt/stt_engine.dart';
import '../stt/stt_service.dart';
import 'protocol.dart';

/// One finished utterance, for the latency overlay.
class UtteranceStats {
  const UtteranceStats({required this.text, required this.ms, required this.computeMs, required this.audioMs});
  final String text;
  final double ms;
  final double computeMs;
  final double audioMs;
  double get rtf => audioMs <= 0 ? 0 : computeMs / audioMs;
}

class VoiceBridge {
  VoiceBridge({required this.runJs, required this.mic, required this.appVersion, required this.platform, this.onUtterance, this.onListening});

  /// Evaluate JS in the page (WebViewController.runJavaScript).
  final Future<void> Function(String js) runJs;
  final MicSource mic;
  final String appVersion;
  final String platform;
  final void Function(UtteranceStats s)? onUtterance;
  final void Function(bool listening)? onListening;

  SpeechToText? _stt;
  String _state = 'loading';
  Map<String, Object?>? _model;
  int? _active;
  Future<bool>? _starting;
  StreamSubscription<String>? _partialSub;

  String get state => _state;

  /// The recogniser finished loading (or failed): tell the page.
  void attach(SpeechToText? stt, {Map<String, Object?>? model, String? error}) {
    _stt = stt;
    _model = model;
    _state = stt != null ? 'ready' : (error != null ? 'error' : 'no-model');
    unawaited(_post(_hello()));
  }

  /// Tell the (re)loaded page what the app offers.
  Future<void> announce() => _post(_hello());

  Map<String, Object?> _hello() => helloEvent(appVersion: appVersion, platform: platform, state: _state, model: _model, hotwords: _stt?.supportsHotwords ?? false, streaming: _stt?.streaming ?? false);

  Future<void> _post(Map<String, Object?> msg) async {
    try {
      await runJs(pageEventJs(msg));
    } catch (_) {/* page navigating; the next hello resyncs */}
  }

  /// Entry point for JavaScriptChannel messages.
  Future<void> handle(String raw) async {
    final PageMessage m;
    try {
      m = PageMessage.parse(raw);
    } on FormatException catch (e) {
      await _post(errorEvent(null, 'bad-message', e.message));
      return;
    }
    switch (m) {
      case HelloMessage():
        await _post(_hello());
      case StartMessage():
        await _start(m);
      case StopMessage():
        await _stop(m.id);
      case CancelMessage():
        await _cancel(m.id);
    }
  }

  Future<void> _start(StartMessage m) async {
    final stt = _stt;
    if (stt == null) {
      await _post(errorEvent(m.id, 'no-model', _state == 'loading' ? 'The speech model is still loading.' : 'No speech model on this phone yet. Download it from the app menu.'));
      return;
    }
    if (_active != null) await _cancel(_active!);   // a new PTT supersedes one we never got a stop for
    _active = m.id;
    final c = Completer<bool>();
    _starting = c.future;
    try {
      if (!await mic.ensurePermission()) {
        _active = null;
        await _post(errorEvent(m.id, 'mic-denied', 'Microphone permission is off. Allow it in Android Settings > Apps > OpenATC > Permissions.'));
        c.complete(false);
        return;
      }
      // the page sends how each aircraft is said ("speedbird 273"); bare callsigns are only spelled out when it does not
      stt.begin(buildHotwords(spoken: m.hotwords.isNotEmpty ? m.hotwords : m.callsigns));
      await _partialSub?.cancel();
      final id = m.id;
      _partialSub = stt.partials.listen((t) {
        if (_active == id && t.isNotEmpty) unawaited(_post(partialEvent(id, t)));
      });
      await mic.open(stt.feed);
      onListening?.call(true);
      await _post(startedEvent(m.id));
      c.complete(true);
    } catch (e) {
      _active = null;
      await _post(errorEvent(m.id, 'stt', 'Could not start the microphone: $e'));
      if (!c.isCompleted) c.complete(false);
    }
  }

  Future<void> _stop(int id) async {
    final ok = await (_starting ?? Future.value(false));
    if (_active != id || !ok) return;
    final t = Stopwatch()..start();
    try {
      await mic.close();
      onListening?.call(false);
      final SttResult r = await _stt!.finish();
      t.stop();
      final ms = t.elapsedMicroseconds / 1000;
      _active = null;
      await _partialSub?.cancel();
      _partialSub = null;
      await _post(finalEvent(id, r.text, ms: ms, computeMs: r.computeMs, audioMs: r.audioMs, model: _stt!.modelLabel));
      onUtterance?.call(UtteranceStats(text: r.text, ms: ms, computeMs: r.computeMs, audioMs: r.audioMs));
    } catch (e) {
      _active = null;
      onListening?.call(false);
      await _post(errorEvent(id, 'stt', 'Speech recognition failed: $e'));
    }
  }

  Future<void> _cancel(int id) async {
    if (_active != id) return;
    _active = null;
    await _partialSub?.cancel();
    _partialSub = null;
    try {
      await mic.close();
    } catch (_) {}
    onListening?.call(false);
    _stt?.cancel();
  }

  /// The page is (re)loading: forget the utterance in flight.
  Future<void> reset() async {
    if (_active != null) await _cancel(_active!);
  }
}
