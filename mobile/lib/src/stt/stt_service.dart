// Runs the recogniser in a background isolate so decoding never blocks the UI thread (the WebView keeps animating
// while the phone transcribes). The main isolate owns the microphone and forwards PCM chunks here.

import 'dart:async';
import 'dart:isolate';
import 'dart:typed_data';

import '../models/manifest.dart';
import 'stt_engine.dart';

/// What the bridge needs from a recogniser (an interface so tests can use a fake).
abstract class SpeechToText {
  bool get supportsHotwords;
  bool get streaming;
  String get modelLabel;

  /// Partial transcripts of the current utterance.
  Stream<String> get partials;
  void begin(String hotwords);

  /// PCM16 LE mono at the model's sample rate.
  void feed(Uint8List pcm16);
  Future<SttResult> finish();
  void cancel();
  Future<void> dispose();
}

class IsolateStt implements SpeechToText {
  IsolateStt._(this._isolate, this._send, this.spec, this.supportsHotwords, this.streaming, this.loadMs);

  final Isolate _isolate;
  final SendPort _send;
  final ModelSpec spec;
  @override
  final bool supportsHotwords;
  @override
  final bool streaming;

  /// Time to load the model (ONNX Runtime session creation), for the status line.
  final int loadMs;
  final _partials = StreamController<String>.broadcast();
  Completer<SttResult>? _pending;
  StreamSubscription<dynamic>? _sub;

  @override
  String get modelLabel => '${spec.id}@${spec.version}';
  @override
  Stream<String> get partials => _partials.stream;

  static Future<IsolateStt> start(ModelSpec spec, String dir, {SttOptions options = const SttOptions()}) async {
    final rx = ReceivePort();
    final iso = await Isolate.spawn(_main, rx.sendPort, debugName: 'stt');
    final events = rx.asBroadcastStream();
    final first = Completer<SendPort>();
    final loaded = Completer<Map<dynamic, dynamic>>();
    final sub = events.listen((m) {
      if (m is SendPort && !first.isCompleted) {
        first.complete(m);
      } else if (m is Map && (m['t'] == 'loaded' || m['t'] == 'loadError') && !loaded.isCompleted) {
        loaded.complete(m);
      }
    });
    final send = await first.future;
    send.send({'t': 'load', 'spec': spec.toJson(), 'dir': dir, 'threads': options.threads, 'hot': options.useHotwords});
    final r = await loaded.future;
    await sub.cancel();
    if (r['t'] == 'loadError') {
      iso.kill(priority: Isolate.immediate);
      rx.close();
      throw StateError('Speech model failed to load: ${r['e']}');
    }
    final s = IsolateStt._(iso, send, spec, r['hot'] as bool, r['streaming'] as bool, r['ms'] as int);
    s._sub = events.listen(s._onEvent);
    return s;
  }

  void _onEvent(dynamic m) {
    if (m is! Map) return;
    switch (m['t']) {
      case 'partial':
        _partials.add(m['text'] as String);
      case 'final':
        _pending?.complete(SttResult(text: m['text'] as String, finishMs: m['ms'] as double, computeMs: m['computeMs'] as double, audioMs: m['audioMs'] as double));
        _pending = null;
      case 'error':
        _pending?.completeError(StateError(m['e'] as String));
        _pending = null;
    }
  }

  @override
  void begin(String hotwords) => _send.send({'t': 'begin', 'hot': hotwords});

  @override
  void feed(Uint8List pcm16) => _send.send({'t': 'pcm', 'b': TransferableTypedData.fromList([pcm16])});

  @override
  Future<SttResult> finish() {
    _pending?.completeError(StateError('superseded'));
    final c = _pending = Completer<SttResult>();
    _send.send({'t': 'finish'});
    return c.future;
  }

  @override
  void cancel() => _send.send({'t': 'cancel'});

  @override
  Future<void> dispose() async {
    _send.send({'t': 'dispose'});
    await _sub?.cancel();
    await _partials.close();
    _isolate.kill();
  }
}

void _main(SendPort out) {
  final rx = ReceivePort();
  out.send(rx.sendPort);
  SttEngine? eng;
  var last = '';
  rx.listen((m) {
    if (m is! Map) return;
    try {
      switch (m['t']) {
        case 'load':
          final sw = Stopwatch()..start();
          final spec = ModelSpec.fromJson((m['spec'] as Map).cast<String, dynamic>());
          eng = SttEngine.load(spec, m['dir'] as String, options: SttOptions(threads: m['threads'] as int, useHotwords: m['hot'] as bool));
          // warm-up: the first decode pays for ONNX Runtime's lazy allocations; do it now, not on the first PTT
          eng!.begin();
          eng!.accept(Float32List(spec.sampleRate ~/ 2));
          eng!.finish();
          out.send({'t': 'loaded', 'hot': eng!.supportsHotwords, 'streaming': eng!.streaming, 'ms': sw.elapsedMilliseconds});
        case 'begin':
          last = '';
          eng?.begin(hotwords: m['hot'] as String);
        case 'pcm':
          final e = eng;
          if (e == null) return;
          e.accept(pcm16ToFloat((m['b'] as TransferableTypedData).materialize().asUint8List()));
          if (e.streaming) {
            final p = e.partial();
            if (p != last) {
              last = p;
              out.send({'t': 'partial', 'text': p});
            }
          }
        case 'finish':
          final r = eng!.finish();
          out.send({'t': 'final', 'text': r.text, 'ms': r.finishMs, 'computeMs': r.computeMs, 'audioMs': r.audioMs});
        case 'cancel':
          eng?.cancel();
        case 'dispose':
          eng?.dispose();
          eng = null;
          rx.close();
      }
    } catch (e) {
      out.send({'t': m['t'] == 'load' ? 'loadError' : 'error', 'e': e.toString()});
    }
  });
}
