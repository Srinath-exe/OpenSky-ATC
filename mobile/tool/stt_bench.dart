// Run the app's on-device recogniser (lib/src/stt) on the speech-to-text bake-off clips, on this Linux box.
//
// Same SttEngine, same hotword builder, same sherpa-onnx version as the phone; only the CPU differs. Audio is fed in
// 100 ms chunks like the microphone does, then finish() is timed (= the wait after the player releases PTT).
//
//   dart run tool/stt_bench.dart --manifest tool/bench_models.json --model <id> --dir <model dir> \
//       --clips ../ml/gpu/results/stt --out /tmp/bench [--no-hotwords] [--score 1.5] [--threads 2] [--n 200]
//
// Writes <out>/<label>.json as {"model", "rows": [{"i", "heard", "ms", "computeMs", "audioMs"}]}: the format
// ml/stt/score.py reads (copy clips.json next to it and run score.py --dir <out> for WER and command accuracy).

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:openatc/src/models/manifest.dart';
import 'package:openatc/src/stt/hotwords.dart';
import 'package:openatc/src/stt/stt_engine.dart';

Float32List readNpyF32(String path) {
  final b = File(path).readAsBytesSync();
  if (b[0] != 0x93 || String.fromCharCodes(b.sublist(1, 6)) != 'NUMPY') throw FormatException('not .npy: $path');
  final major = b[6];
  final bd = ByteData.sublistView(b);
  final hlen = major == 1 ? bd.getUint16(8, Endian.little) : bd.getUint32(8, Endian.little);
  final start = (major == 1 ? 10 : 12) + hlen;
  final header = String.fromCharCodes(b.sublist(major == 1 ? 10 : 12, start));
  if (!header.contains("'<f4'")) throw FormatException('expected float32: $header');
  return Float32List.fromList(Float32List.sublistView(Uint8List.fromList(b.sublist(start))));
}

/// What the page sends for this game state: the spoken name of every aircraft + the active runways.
({List<String> spoken, List<String> extra}) hintsFromContext(String ctx) {
  final lines = ctx.split('\n');
  final rwys = lines.first.split(' ').skip(1).map((r) => 'runway $r').toList();
  final spoken = <String>[];
  for (final l in lines.skip(1)) {
    final t = l.trim().split(RegExp(r'\s+'));
    final k = t.indexWhere((w) => w == 'ARR' || w == 'DEP');
    if (k > 1) spoken.add(t.sublist(1, k).join(' '));
  }
  return (spoken: spoken, extra: rwys);
}

void main(List<String> argv) {
  String arg(String k, [String? d]) {
    final i = argv.indexOf('--$k');
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    if (d != null) return d;
    stderr.writeln('missing --$k');
    exit(2);
  }

  final manifest = ModelManifest.parse(File(arg('manifest', 'tool/bench_models.json')).readAsStringSync());
  final spec = manifest.models.firstWhere((m) => m.id == arg('model', manifest.active));
  final useHot = !argv.contains('--no-hotwords');
  final noPhrases = argv.contains('--no-phraseology');
  final score = double.parse(arg('score', '2.0'));   // callsign phrases; names get 75 %, phraseology 50 %
  final hopts = HotwordOptions(callsignScore: score, nameScore: score * .75, phraseScore: score * .5, digitsOnly: !argv.contains('--no-digits'));
  final threads = int.parse(arg('threads', '2'));
  final opts = SttOptions(threads: threads, useHotwords: useHot);
  final engine = SttEngine.load(spec, arg('dir'), options: opts);
  final clipsDir = arg('clips', '../ml/gpu/results/stt');
  final clips = (jsonDecode(File('$clipsDir/clips.json').readAsStringSync()) as List).cast<Map<String, dynamic>>();
  final n = int.parse(arg('n', '${clips.length}'));
  final label = arg('label', '${spec.id}${engine.supportsHotwords ? '+hot${score.toStringAsFixed(1)}${noPhrases ? '-np' : ''}${argv.contains('--no-digits') ? '-nd' : ''}' : ''}');
  final rows = <Map<String, dynamic>>[];
  final chunk = spec.sampleRate ~/ 10;
  var worst = 0.0;
  for (final c in clips.take(n)) {
    final i = c['i'] as int;
    final audio = readNpyF32('$clipsDir/clip${i.toString().padLeft(4, '0')}.npy');
    final h = hintsFromContext(c['ctx'] as String);
    final hot = buildHotwords(spoken: h.spoken, extra: h.extra, phraseology: !noPhrases, o: hopts);
    engine.begin(hotwords: hot);
    for (var o = 0; o < audio.length; o += chunk) {
      engine.accept(Float32List.sublistView(audio, o, (o + chunk).clamp(0, audio.length)));
    }
    final r = engine.finish();
    if (r.finishMs > worst) worst = r.finishMs;
    rows.add({'i': i, 'heard': r.text, 'ms': double.parse(r.finishMs.toStringAsFixed(1)), 'computeMs': double.parse(r.computeMs.toStringAsFixed(1)), 'audioMs': r.audioMs.round()});
    if (rows.length <= 3) stdout.writeln('${c['text']}\n  -> ${r.text}  (${r.finishMs.toStringAsFixed(0)} ms after release, rtf ${r.rtf.toStringAsFixed(3)})');
  }
  engine.dispose();
  final out = Directory(arg('out'))..createSync(recursive: true);
  File('${out.path}/$label.json').writeAsStringSync(jsonEncode({'model': label, 'rows': rows}));
  final ms = rows.map((r) => r['ms'] as double).toList()..sort();
  final comp = rows.fold(0.0, (s, r) => s + (r['computeMs'] as double));
  final aud = rows.fold(0, (s, r) => s + (r['audioMs'] as int));
  stdout.writeln(jsonEncode({'model': label, 'n': rows.length, 'release_ms_p50': ms[ms.length ~/ 2], 'release_ms_p95': ms[(ms.length * .95).floor()], 'rtf': double.parse((comp / aud).toStringAsFixed(4)), 'threads': threads}));
}
