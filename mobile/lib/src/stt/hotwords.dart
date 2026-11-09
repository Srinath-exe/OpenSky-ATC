// Hotwords (contextual biasing): words the recogniser should prefer right now.
//
// A transducer's beam search keeps several candidate transcripts; with hotwords, sherpa-onnx walks a small graph of the
// given phrases (an Aho-Corasick automaton over the model's sub-word tokens) and adds a bonus to every candidate that is
// in the middle of one. "SPEEDBIRD TWO SEVEN THREE" then beats "SPEED BIRD TO SEVEN THREE" without retraining.
//
// The page sends what the game knows (callsigns + how a controller says them, runways); this file turns that into the
// model's text form: upper case, digits spoken one by one, runway suffixes as words, plus a fixed list of phraseology.

/// Words a controller uses; they are boosted less than the callsigns of the aircraft actually on the scope.
const List<String> kPhraseology = [
  'FLY HEADING', 'TURN LEFT HEADING', 'TURN RIGHT HEADING', 'CLIMB AND MAINTAIN', 'DESCEND AND MAINTAIN', 'CLIMB',
  'DESCEND', 'MAINTAIN', 'FLIGHT LEVEL', 'THOUSAND', 'REDUCE SPEED', 'INCREASE SPEED', 'KNOTS', 'EXPEDITE',
  'CLEARED ILS APPROACH', 'CLEARED TO LAND', 'CLEARED FOR TAKEOFF', 'LINE UP AND WAIT', 'HOLD SHORT', 'HOLD POSITION',
  'HOLDING POINT', 'TAXI TO', 'TAXI VIA', 'CROSS RUNWAY', 'RUNWAY', 'CONTACT TOWER', 'CONTACT GROUND',
  'CONTACT APPROACH', 'CONTACT DEPARTURE', 'DECIMAL', 'PUSHBACK APPROVED', 'START UP APPROVED', 'GIVE WAY',
  'PROCEED DIRECT', 'DIRECT', 'EXPECT', 'ESTABLISHED', 'LOCALIZER', 'GO AROUND', 'ROGER', 'STANDBY', 'UNABLE',
  'SAY AGAIN', 'WIND', 'SQUAWK', 'NINER', 'REPORT', 'VACATE', 'BEHIND',
];

const List<String> kPhonetic = [
  'ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA', 'JULIETT', 'KILO', 'LIMA', 'MIKE',
  'NOVEMBER', 'OSCAR', 'PAPA', 'QUEBEC', 'ROMEO', 'SIERRA', 'TANGO', 'UNIFORM', 'VICTOR', 'WHISKEY', 'XRAY', 'YANKEE',
  'ZULU',
];

const List<String> _digit = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
const Map<String, String> _side = {'L': 'LEFT', 'R': 'RIGHT', 'C': 'CENTER'};

/// "speedbird 273" -> [SPEEDBIRD, TWO, SEVEN, THREE]; "runway 27R" -> [RUNWAY, TWO, SEVEN, RIGHT];
/// "n123ab" -> [NOVEMBER, ONE, TWO, THREE, ALPHA, BRAVO].
List<String> spokenWords(String phrase) {
  final out = <String>[];
  final toks = phrase.toUpperCase().split(RegExp(r"[^A-Z0-9']+")).where((t) => t.isNotEmpty).toList();
  for (var i = 0; i < toks.length; i++) {
    final t = toks[i];
    final prev = out.isEmpty ? '' : out.last;
    final rwy = RegExp(r'^(\d{1,2})([LRC])$').firstMatch(t);
    if (rwy != null && prev == 'RUNWAY') {
      out.addAll(rwy.group(1)!.split('').map((d) => _digit[int.parse(d)]));
      out.add(_side[rwy.group(2)]!);
    } else if (RegExp(r'^[A-Z][A-Z\x27]*$').hasMatch(t) && !RegExp(r'\d').hasMatch(t)) {
      out.add(t);
    } else {
      for (final run in RegExp(r'\d+|[A-Z]+').allMatches(t).map((m) => m.group(0)!)) {
        if (RegExp(r'^\d+$').hasMatch(run)) {
          out.addAll(run.split('').map((d) => _digit[int.parse(d)]));
        } else {
          out.addAll(run.split('').map((c) => kPhonetic[c.codeUnitAt(0) - 65]));
        }
      }
    }
  }
  return out;
}

class HotwordOptions {
  const HotwordOptions({this.callsignScore = 2.0, this.nameScore = 1.5, this.phraseScore = 1.0, this.digitsOnly = true, this.maxLines = 200});
  final double callsignScore;
  final double nameScore;
  final double phraseScore;

  /// Also boost the bare flight number ("nine seven three fly heading ...": players often drop the airline).
  final bool digitsOnly;
  final int maxLines;
}

/// sherpa-onnx per-stream hotwords: one phrase per entry with an optional ":score", joined with '/'.
/// [spoken] are the controller's words for each aircraft on the scope ("speedbird 273"), [extra] any other phrase
/// the page wants biased (runways, fixes).
String buildHotwords({List<String> spoken = const [], List<String> extra = const [], HotwordOptions o = const HotwordOptions(), bool phraseology = true}) {
  final lines = <String>[];
  final seen = <String>{};
  void add(List<String> words, double score) {
    if (words.isEmpty || lines.length >= o.maxLines) return;
    final p = words.join(' ');
    if (seen.add(p)) lines.add('$p :${score.toStringAsFixed(1)}');
  }

  for (final s in spoken) {
    final w = spokenWords(s);
    add(w, o.callsignScore);
    final firstDigit = w.indexWhere(_digit.contains);
    if (firstDigit > 0) {
      add(w.sublist(0, firstDigit), o.nameScore);                  // the telephony alone: "SPEEDBIRD", "SKY DUBAI"
      if (o.digitsOnly && w.length - firstDigit >= 2) add(w.sublist(firstDigit), o.nameScore);
    }
  }
  for (final s in extra) {
    add(spokenWords(s), o.nameScore);
  }
  if (phraseology) {
    for (final p in kPhraseology) {
      add(p.split(' '), o.phraseScore);
    }
    for (final p in kPhonetic) {
      add([p], o.phraseScore);
    }
  }
  return lines.join('/');
}
