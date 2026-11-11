// On-device speech-to-text over sherpa-onnx (ONNX Runtime underneath). Pure Dart + FFI, no Flutter: the app runs it in
// a background isolate, and tool/stt_bench.dart runs the same code on a Linux box against recorded clips.
//
// One utterance per push-to-talk: begin(hotwords) -> accept(samples)* -> finish().
//  - transducer (streaming zipformer): audio is decoded while the player talks, so partial text is available and
//    finish() only has to flush the last ~0.3 s; hotwords bias the beam search towards the callsigns on the scope
//  - moonshine (offline): audio is buffered and transcribed on finish()

import 'dart:io';
import 'dart:typed_data';

import 'package:sherpa_onnx/sherpa_onnx.dart' as so;

import '../models/manifest.dart';
import 'bpe_vocab.dart';

class SttResult {
  const SttResult({required this.text, required this.finishMs, required this.computeMs, required this.audioMs});

  final String text;

  /// PTT release -> final text (what the player waits for).
  final double finishMs;

  /// Total time spent inside the recogniser for this utterance (streaming decode + flush).
  final double computeMs;

  /// Length of the utterance.
  final double audioMs;

  /// Real-time factor: compute time / audio time (0.1 = ten times faster than real time).
  double get rtf => audioMs <= 0 ? 0 : computeMs / audioMs;

  Map<String, dynamic> toJson() => {'text': text, 'ms': _r(finishMs), 'computeMs': _r(computeMs), 'audioMs': _r(audioMs), 'rtf': double.parse(rtf.toStringAsFixed(3))};
}

double _r(double v) => double.parse(v.toStringAsFixed(1));

class SttOptions {
  const SttOptions({this.threads = 2, this.hotwordsScore = 1.5, this.maxActivePaths = 4, this.useHotwords = true, this.tailPaddingSec = 0.4});
  final int threads;
  final double hotwordsScore;
  final int maxActivePaths;
  final bool useHotwords;

  /// Silence appended at release so the streaming encoder sees its right context and emits the last word.
  final double tailPaddingSec;
}

bool _bindingsReady = false;

/// Load the sherpa-onnx native library (once per isolate).
void initSherpa([String? libDir]) {
  if (_bindingsReady) return;
  so.initBindings(libDir);
  _bindingsReady = true;
}

abstract class SttEngine {
  ModelSpec get spec;
  bool get supportsHotwords;
  bool get streaming;

  /// Start an utterance. [hotwords]: buildHotwords() output; ignored by models that cannot use it.
  void begin({String hotwords = ''});
  void accept(Float32List samples);

  /// Current partial text ('' for offline models).
  String partial();
  SttResult finish();
  void cancel();
  void dispose();

  /// Build the engine for an installed model directory.
  static SttEngine load(ModelSpec spec, String dir, {SttOptions options = const SttOptions()}) {
    initSherpa();
    return switch (spec.kind) {
      ModelKind.transducer => _TransducerEngine(spec, dir, options),
      ModelKind.moonshine => _MoonshineEngine(spec, dir, options),
      ModelKind.nemoTransducer => _MoonshineEngine(spec, dir, options, nemo: true),
    };
  }
}

String _path(ModelSpec spec, String dir, String role) => '$dir/${spec.file(role)!.name}';

/// Write bpe.vocab next to bpe.model (once) and return its path.
String ensureBpeVocab(String bpeModelPath) {
  final out = File(bpeModelPath.replaceAll(RegExp(r'\.model$'), '.vocab'));
  if (!out.existsSync() || out.lengthSync() == 0) {
    out.writeAsStringSync(bpeVocabFromModel(File(bpeModelPath).readAsBytesSync()), flush: true);
  }
  return out.path;
}

class _TransducerEngine implements SttEngine {
  _TransducerEngine(this.spec, String dir, this.o) {
    final hot = spec.hotwords && o.useHotwords;
    final model = so.OnlineModelConfig(
      transducer: so.OnlineTransducerModelConfig(
        encoder: _path(spec, dir, 'encoder'),
        decoder: _path(spec, dir, 'decoder'),
        joiner: _path(spec, dir, 'joiner'),
      ),
      tokens: _path(spec, dir, 'tokens'),
      numThreads: o.threads,
      debug: false,
      modelType: spec.modelType,
      modelingUnit: hot ? 'bpe' : '',
      bpeVocab: hot ? ensureBpeVocab(_path(spec, dir, 'bpe_model')) : '',
    );
    _rec = so.OnlineRecognizer(so.OnlineRecognizerConfig(
      model: model,
      feat: so.FeatureConfig(sampleRate: spec.sampleRate, featureDim: 80),
      // hotwords only work with beam search; greedy is a bit faster when there is nothing to bias
      decodingMethod: hot ? 'modified_beam_search' : 'greedy_search',
      maxActivePaths: o.maxActivePaths,
      hotwordsScore: o.hotwordsScore,
      enableEndpoint: false, // push-to-talk decides where the utterance ends
    ));
    supportsHotwords = hot;
  }

  @override
  final ModelSpec spec;
  final SttOptions o;
  late final so.OnlineRecognizer _rec;
  so.OnlineStream? _stream;
  final Stopwatch _compute = Stopwatch();
  int _samples = 0;

  @override
  late final bool supportsHotwords;
  @override
  bool get streaming => true;

  @override
  void begin({String hotwords = ''}) {
    cancel();
    _compute.reset();
    _samples = 0;
    _stream = supportsHotwords && hotwords.isNotEmpty ? _rec.createStream(hotwords: hotwords) : _rec.createStream();
  }

  @override
  void accept(Float32List samples) {
    final s = _stream;
    if (s == null) return;
    _compute.start();
    s.acceptWaveform(samples: samples, sampleRate: spec.sampleRate);
    while (_rec.isReady(s)) {
      _rec.decode(s);
    }
    _compute.stop();
    _samples += samples.length;
  }

  @override
  String partial() => _stream == null ? '' : _rec.getResult(_stream!).text.trim();

  @override
  SttResult finish() {
    final s = _stream;
    if (s == null) return const SttResult(text: '', finishMs: 0, computeMs: 0, audioMs: 0);
    final t = Stopwatch()..start();
    _compute.start();
    s.acceptWaveform(samples: Float32List((spec.sampleRate * o.tailPaddingSec).round()), sampleRate: spec.sampleRate);
    s.inputFinished();
    while (_rec.isReady(s)) {
      _rec.decode(s);
    }
    final text = _rec.getResult(s).text.trim();
    _compute.stop();
    t.stop();
    s.free();
    _stream = null;
    return SttResult(text: text, finishMs: t.elapsedMicroseconds / 1000, computeMs: _compute.elapsedMicroseconds / 1000, audioMs: _samples * 1000 / spec.sampleRate);
  }

  @override
  void cancel() {
    _stream?.free();
    _stream = null;
  }

  @override
  void dispose() {
    cancel();
    _rec.free();
  }
}

class _MoonshineEngine implements SttEngine {
  /// Offline (whole utterance on release) recognisers: Moonshine, or with [nemo] a NeMo transducer such as Parakeet
  /// TDT 110M fine-tuned on ATC speech (ml/stt/train_parakeet.py; encoder/decoder/joiner/tokens, greedy search).
  _MoonshineEngine(this.spec, String dir, this.o, {bool nemo = false}) {
    _rec = so.OfflineRecognizer(so.OfflineRecognizerConfig(
      model: nemo
          ? so.OfflineModelConfig(
              transducer: so.OfflineTransducerModelConfig(
                encoder: _path(spec, dir, 'encoder'),
                decoder: _path(spec, dir, 'decoder'),
                joiner: _path(spec, dir, 'joiner'),
              ),
              tokens: _path(spec, dir, 'tokens'),
              modelType: 'nemo_transducer',
              numThreads: o.threads,
              debug: false,
            )
          : so.OfflineModelConfig(
              moonshine: so.OfflineMoonshineModelConfig(
                encoder: _path(spec, dir, 'encoder'),
                mergedDecoder: _path(spec, dir, 'merged_decoder'),
              ),
              tokens: _path(spec, dir, 'tokens'),
              numThreads: o.threads,
              debug: false,
            ),
    ));
  }

  @override
  final ModelSpec spec;
  final SttOptions o;
  late final so.OfflineRecognizer _rec;
  final List<Float32List> _chunks = [];
  bool _open = false;

  @override
  bool get supportsHotwords => false;
  @override
  bool get streaming => false;

  @override
  void begin({String hotwords = ''}) {
    _chunks.clear();
    _open = true;
  }

  @override
  void accept(Float32List samples) {
    if (_open) _chunks.add(Float32List.fromList(samples));
  }

  @override
  String partial() => '';

  @override
  SttResult finish() {
    _open = false;
    final n = _chunks.fold(0, (s, c) => s + c.length);
    if (n == 0) return const SttResult(text: '', finishMs: 0, computeMs: 0, audioMs: 0);
    final all = Float32List(n);
    var off = 0;
    for (final c in _chunks) {
      all.setAll(off, c);
      off += c.length;
    }
    _chunks.clear();
    final t = Stopwatch()..start();
    final s = _rec.createStream();
    s.acceptWaveform(samples: all, sampleRate: spec.sampleRate);
    _rec.decode(s);
    final text = _rec.getResult(s).text.trim();
    s.free();
    t.stop();
    final ms = t.elapsedMicroseconds / 1000;
    return SttResult(text: text, finishMs: ms, computeMs: ms, audioMs: n * 1000 / spec.sampleRate);
  }

  @override
  void cancel() {
    _chunks.clear();
    _open = false;
  }

  @override
  void dispose() {
    cancel();
    _rec.free();
  }
}

/// PCM16 little-endian bytes (what the microphone plugin streams) -> float samples in [-1, 1].
Float32List pcm16ToFloat(Uint8List bytes) {
  final n = bytes.length ~/ 2;
  final d = ByteData.sublistView(bytes, 0, n * 2);
  final out = Float32List(n);
  for (var i = 0; i < n; i++) {
    out[i] = d.getInt16(i * 2, Endian.little) / 32768.0;
  }
  return out;
}
