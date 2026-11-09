import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/audio/mic.dart';
import 'package:openatc/src/bridge/protocol.dart';
import 'package:openatc/src/bridge/voice_bridge.dart';
import 'package:openatc/src/stt/stt_engine.dart';
import 'package:openatc/src/stt/stt_service.dart';

class FakeMic implements MicSource {
  bool allow = true;
  void Function(Uint8List)? sink;
  int opens = 0, closes = 0;
  @override
  Future<bool> ensurePermission() async => allow;
  @override
  Future<void> open(void Function(Uint8List) onPcm) async {
    opens++;
    sink = onPcm;
  }

  @override
  Future<void> close() async {
    closes++;
    sink = null;
  }

  @override
  Future<void> dispose() async {}
}

class FakeStt implements SpeechToText {
  final _p = StreamController<String>.broadcast();
  String hotwords = '';
  int fed = 0, cancels = 0;
  @override
  bool get supportsHotwords => true;
  @override
  bool get streaming => true;
  @override
  String get modelLabel => 'fake@1';
  @override
  Stream<String> get partials => _p.stream;
  @override
  void begin(String h) {
    hotwords = h;
    fed = 0;
  }

  @override
  void feed(Uint8List pcm16) {
    fed += pcm16.length;
    _p.add('speedbird two');
  }

  @override
  Future<SttResult> finish() async => SttResult(text: 'SPEEDBIRD TWO SEVEN THREE CLIMB', finishMs: 40, computeMs: 120, audioMs: fed / 32);
  @override
  void cancel() => cancels++;
  @override
  Future<void> dispose() async {}
}

/// Pull the event objects back out of the JS the bridge evaluated.
Map<String, dynamic> _event(String js) {
  final m = RegExp(r"new CustomEvent\('openatc-native',\{detail:(.*)\}\)\);$").firstMatch(js)!;
  return jsonDecode(m.group(1)!.replaceAll(r'<\/', '</')) as Map<String, dynamic>;
}

void main() {
  group('protocol', () {
    test('parses the page messages', () {
      expect(PageMessage.parse('{"v":1,"type":"hello"}'), isA<HelloMessage>());
      final s = PageMessage.parse(jsonEncode({'v': 1, 'type': 'start', 'id': 7, 'callsigns': ['BAW273', 3], 'hotwords': ['speedbird 273']})) as StartMessage;
      expect(s.id, 7);
      expect(s.callsigns, ['BAW273'], reason: 'non-strings dropped');
      expect(s.hotwords, ['speedbird 273']);
      expect((PageMessage.parse('{"type":"stop","id":7.0}') as StopMessage).id, 7);
      expect(PageMessage.parse('{"type":"cancel","id":2}'), isA<CancelMessage>());
    });

    test('rejects malformed messages', () {
      for (final bad in ['nope', '[]', '{"type":"start"}', '{"type":"fly"}', '{"v":2,"type":"hello"}', '{"type":"start","id":1,"hotwords":"x"}']) {
        expect(() => PageMessage.parse(bad), throwsFormatException, reason: bad);
      }
    });

    test('caps list sizes and string lengths from the page', () {
      final s = PageMessage.parse(jsonEncode({'type': 'start', 'id': 1, 'callsigns': List.filled(500, 'X' * 200)})) as StartMessage;
      expect(s.callsigns.length, 80);
      expect(s.callsigns.first.length, 64);
    });

    test('event JS is a single dispatchEvent call and cannot break out of the string', () {
      final js = pageEventJs(partialEvent(3, 'a "quote" </script> \u2028 line'));
      expect(js, startsWith("window.dispatchEvent(new CustomEvent('openatc-native',{detail:"));
      expect(js, isNot(contains('</script>')));
      expect(js, isNot(contains('\u2028')));
      expect(_event(js), {'type': 'partial', 'id': 3, 'text': 'a "quote" </script> \u2028 line'});
    });

    test('final event carries the on-device timings', () {
      final e = finalEvent(1, 'X', ms: 85.04, computeMs: 300, audioMs: 3000, model: 'zf@1');
      expect(e, {'type': 'final', 'id': 1, 'text': 'X', 'ms': 85.0, 'computeMs': 300.0, 'audioMs': 3000.0, 'rtf': 0.1, 'model': 'zf@1'});
    });
  });

  group('VoiceBridge', () {
    late List<Map<String, dynamic>> sent;
    late FakeMic mic;
    late FakeStt stt;
    late VoiceBridge bridge;
    late List<UtteranceStats> utterances;

    setUp(() {
      sent = [];
      utterances = [];
      mic = FakeMic();
      stt = FakeStt();
      bridge = VoiceBridge(runJs: (js) async => sent.add(_event(js)), mic: mic, appVersion: '1.0.0', platform: 'android', onUtterance: utterances.add);
    });

    test('before the model is attached: hello says loading, start says no-model', () async {
      await bridge.handle('{"type":"hello"}');
      expect(sent.last['type'], 'hello');
      expect(sent.last['state'], 'loading');
      await bridge.handle('{"type":"start","id":1}');
      expect(sent.last, containsPair('code', 'no-model'));
      expect(mic.opens, 0);
    });

    test('PTT: start -> partials -> stop -> final with latency', () async {
      bridge.attach(stt, model: {'id': 'zf'});
      expect(sent.last, containsPair('state', 'ready'));
      expect(sent.last, containsPair('hotwords', true));
      await bridge.handle(jsonEncode({'type': 'start', 'id': 5, 'callsigns': ['BAW273', 'N123AB'], 'hotwords': ['speedbird 273', 'runway 27R']}));
      expect(sent.last, {'type': 'started', 'id': 5});
      expect(stt.hotwords, contains('SPEEDBIRD TWO SEVEN THREE :2.0'));
      expect(stt.hotwords, contains('RUNWAY TWO SEVEN RIGHT'));
      expect(stt.hotwords, isNot(contains('BRAVO ALPHA WHISKEY')), reason: 'the spoken forms are used, not the ICAO codes');
      mic.sink!(Uint8List(3200));
      await Future<void>.delayed(Duration.zero);
      expect(sent.last, {'type': 'partial', 'id': 5, 'text': 'speedbird two'});
      await bridge.handle('{"type":"stop","id":5}');
      final f = sent.last;
      expect(f['type'], 'final');
      expect(f['id'], 5);
      expect(f['text'], 'SPEEDBIRD TWO SEVEN THREE CLIMB');
      expect(f['ms'], isA<num>());
      expect(f['computeMs'], 120.0);
      expect(f['audioMs'], 100.0);
      expect(f['model'], 'fake@1');
      expect(mic.closes, 1);
      expect(utterances.single.text, 'SPEEDBIRD TWO SEVEN THREE CLIMB');
    });

    test('without spoken forms the callsigns themselves are spelled', () async {
      bridge.attach(stt);
      await bridge.handle(jsonEncode({'type': 'start', 'id': 9, 'callsigns': ['N123AB']}));
      expect(stt.hotwords, startsWith('NOVEMBER ONE TWO THREE ALPHA BRAVO :2.0/'));
    });

    test('a stop for another id is ignored', () async {
      bridge.attach(stt);
      await bridge.handle('{"type":"start","id":1}');
      await bridge.handle('{"type":"stop","id":2}');
      expect(sent.where((e) => e['type'] == 'final'), isEmpty);
    });

    test('mic permission denied is reported to the page', () async {
      bridge.attach(stt);
      mic.allow = false;
      await bridge.handle('{"type":"start","id":1}');
      expect(sent.last, containsPair('code', 'mic-denied'));
      await bridge.handle('{"type":"stop","id":1}');
      expect(sent.where((e) => e['type'] == 'final'), isEmpty);
    });

    test('cancel closes the mic and drops the utterance; a new start supersedes an open one', () async {
      bridge.attach(stt);
      await bridge.handle('{"type":"start","id":1}');
      await bridge.handle('{"type":"cancel","id":1}');
      expect(stt.cancels, 1);
      expect(mic.closes, 1);
      await bridge.handle('{"type":"start","id":2}');
      await bridge.handle('{"type":"start","id":3}');
      expect(stt.cancels, 2);
      await bridge.handle('{"type":"stop","id":3}');
      expect(sent.last['id'], 3);
      expect(sent.last['type'], 'final');
    });

    test('garbage from the page gets a bad-message error, not an exception', () async {
      await bridge.handle('{{{');
      expect(sent.last, containsPair('code', 'bad-message'));
    });

    test('a failed model load is reported as state error', () async {
      bridge.attach(null, error: 'boom');
      expect(sent.last, containsPair('state', 'error'));
    });
  });
}
