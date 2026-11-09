// Microphone: 16 kHz mono PCM16 from the `record` plugin. Audio only ever goes to the on-device recogniser.
//
// The mic stays "warm" for a while after a transmission (no start-up gap on the next PTT, and a short pre-roll so a
// word spoken as the button goes down is not clipped), then it is released so Android's mic indicator goes off.

import 'dart:async';
import 'dart:typed_data';

import 'package:record/record.dart';

abstract class MicSource {
  /// Ask for RECORD_AUDIO if needed. false = denied.
  Future<bool> ensurePermission();

  /// Start delivering PCM16 chunks to [onPcm].
  Future<void> open(void Function(Uint8List pcm16) onPcm);

  /// Stop delivering (after the last buffered audio has arrived).
  Future<void> close();
  Future<void> dispose();
}

class RecordMic implements MicSource {
  RecordMic({this.sampleRate = 16000, this.warmFor = const Duration(seconds: 20), this.preRoll = const Duration(milliseconds: 200), this.tail = const Duration(milliseconds: 120)});

  final int sampleRate;
  final Duration warmFor;
  final Duration preRoll;

  /// How long to keep listening after release: the plugin delivers audio in buffers, the last word is still in flight.
  final Duration tail;
  final AudioRecorder _rec = AudioRecorder();
  StreamSubscription<Uint8List>? _sub;
  void Function(Uint8List)? _listener;
  final List<Uint8List> _ring = [];
  int _ringBytes = 0;
  Timer? _idle;

  @override
  Future<bool> ensurePermission() => _rec.hasPermission();

  @override
  Future<void> open(void Function(Uint8List pcm16) onPcm) async {
    _idle?.cancel();
    if (_sub == null) {
      final stream = await _rec.startStream(RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: sampleRate,
        numChannels: 1,
        autoGain: true,
        noiseSuppress: true,
        androidConfig: const AndroidRecordConfig(audioSource: AndroidAudioSource.voiceRecognition, manageBluetooth: false),
      ));
      _sub = stream.listen(_onChunk);
    }
    for (final c in _ring) {
      onPcm(c);
    }
    _ring.clear();
    _ringBytes = 0;
    _listener = onPcm;
  }

  void _onChunk(Uint8List c) {
    final l = _listener;
    if (l != null) {
      l(c);
      return;
    }
    _ring.add(c);
    _ringBytes += c.length;
    final max = sampleRate * 2 * preRoll.inMilliseconds ~/ 1000;
    while (_ringBytes > max && _ring.isNotEmpty) {
      _ringBytes -= _ring.removeAt(0).length;
    }
  }

  @override
  Future<void> close() async {
    await Future<void>.delayed(tail);
    _listener = null;
    _ring.clear();
    _ringBytes = 0;
    _idle?.cancel();
    _idle = Timer(warmFor, _release);
  }

  Future<void> _release() async {
    await _sub?.cancel();
    _sub = null;
    try {
      await _rec.stop();
    } catch (_) {/* already stopped */}
  }

  @override
  Future<void> dispose() async {
    _idle?.cancel();
    await _release();
    await _rec.dispose();
  }
}
