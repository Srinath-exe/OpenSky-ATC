// The JS bridge between the game page (WebView) and the app. Mirrors src/lib/voice/recognizer.ts createNativeRecognizer.
//
// page -> app: window.OpenATCNative.postMessage(JSON.stringify(msg))      (a webview_flutter JavaScriptChannel)
//   {v:1, type:'hello'}                                             which model, is it ready
//   {v:1, type:'start', id, callsigns:[...], hotwords:[...]}        PTT down: open the mic, start an utterance
//   {v:1, type:'stop', id}                                          PTT up: finish, send the final transcript
//   {v:1, type:'cancel', id}                                        drop the utterance
//
// app -> page: window.dispatchEvent(new CustomEvent('openatc-native', {detail: msg}))   (runJavaScript)
//   {type:'hello', app, appVersion, platform, state, model, hotwords, streaming}
//   {type:'started', id}
//   {type:'partial', id, text}
//   {type:'final', id, text, ms, computeMs, audioMs, rtf, model}     ms = PTT release -> text, measured on the phone
//   {type:'error', id, code, message}                                codes: mic-denied | no-model | busy | stt | bad-message

import 'dart:convert';

const String kChannelName = 'OpenATCNative';
const String kPageEvent = 'openatc-native';
const int kProtocolVersion = 1;

sealed class PageMessage {
  const PageMessage();

  /// Parse what the page posted. Throws FormatException on anything malformed (the app answers with an error event).
  static PageMessage parse(String raw) {
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      throw const FormatException('not JSON');
    }
    if (decoded is! Map<String, dynamic>) throw const FormatException('not an object');
    final j = decoded;
    final v = j['v'];
    if (v != null && v != kProtocolVersion) throw FormatException('unsupported protocol version $v');
    final type = j['type'];
    int id() {
      final x = j['id'];
      if (x is int) return x;
      if (x is double && x == x.roundToDouble()) return x.toInt();
      throw FormatException('$type: missing id');
    }

    List<String> strings(String k, int max) {
      final x = j[k];
      if (x == null) return const [];
      if (x is! List) throw FormatException('$k must be a list');
      return x.whereType<String>().map((s) => s.length > 64 ? s.substring(0, 64) : s).take(max).toList();
    }

    return switch (type) {
      'hello' => const HelloMessage(),
      'start' => StartMessage(id(), callsigns: strings('callsigns', 80), hotwords: strings('hotwords', 160)),
      'stop' => StopMessage(id()),
      'cancel' => CancelMessage(id()),
      _ => throw FormatException('unknown type $type'),
    };
  }
}

class HelloMessage extends PageMessage {
  const HelloMessage();
}

class StartMessage extends PageMessage {
  const StartMessage(this.id, {this.callsigns = const [], this.hotwords = const []});
  final int id;

  /// ICAO-style callsigns on the scope ("BAW273").
  final List<String> callsigns;

  /// Spoken forms the page wants biased: "speedbird 273", "runway 27R".
  final List<String> hotwords;
}

class StopMessage extends PageMessage {
  const StopMessage(this.id);
  final int id;
}

class CancelMessage extends PageMessage {
  const CancelMessage(this.id);
  final int id;
}

/// JS that delivers [msg] to the page. JSON is a JS expression; U+2028/2029 are escaped for older JS engines and
/// "</" so the text can never close a script element.
String pageEventJs(Map<String, Object?> msg) {
  final json = jsonEncode(msg).replaceAll('\u2028', r'\u2028').replaceAll('\u2029', r'\u2029').replaceAll('</', r'<\/');
  return "window.dispatchEvent(new CustomEvent('$kPageEvent',{detail:$json}));";
}

Map<String, Object?> helloEvent({required String appVersion, required String platform, required String state, Map<String, Object?>? model, bool hotwords = false, bool streaming = false}) => {
      'type': 'hello',
      'app': 'openatc',
      'appVersion': appVersion,
      'platform': platform,
      'state': state,
      'model': model,
      'hotwords': hotwords,
      'streaming': streaming,
    };

Map<String, Object?> startedEvent(int id) => {'type': 'started', 'id': id};

Map<String, Object?> partialEvent(int id, String text) => {'type': 'partial', 'id': id, 'text': text};

Map<String, Object?> finalEvent(int id, String text, {required double ms, required double computeMs, required double audioMs, required String model}) => {
      'type': 'final',
      'id': id,
      'text': text,
      'ms': _r(ms),
      'computeMs': _r(computeMs),
      'audioMs': _r(audioMs),
      'rtf': audioMs > 0 ? double.parse((computeMs / audioMs).toStringAsFixed(3)) : 0,
      'model': model,
    };

Map<String, Object?> errorEvent(int? id, String code, String message) => {'type': 'error', 'id': id, 'code': code, 'message': message};

double _r(double v) => double.parse(v.toStringAsFixed(1));
