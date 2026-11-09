import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/stt/bpe_vocab.dart';
import 'package:openatc/src/stt/hotwords.dart';
import 'package:openatc/src/stt/stt_engine.dart';

// --- a hand-built SentencePiece ModelProto -------------------------------------------------------------------------
List<int> _varint(int v) {
  final out = <int>[];
  while (v >= 0x80) {
    out.add((v & 0x7f) | 0x80);
    v >>= 7;
  }
  out.add(v);
  return out;
}

List<int> _len(int field, List<int> payload) => [..._varint(field << 3 | 2), ..._varint(payload.length), ...payload];

List<int> _piece(String p, double score, int type) {
  final f = ByteData(4)..setFloat32(0, score, Endian.little);
  return [..._len(1, utf8.encode(p)), ..._varint(2 << 3 | 5), ...f.buffer.asUint8List(), ..._varint(3 << 3 | 0), ..._varint(type)];
}

void main() {
  group('bpe.model -> bpe.vocab', () {
    test('reads pieces in id order and skips the other ModelProto fields', () {
      final proto = Uint8List.fromList([
        ..._len(1, _piece('<blk>', 0, 3)),
        ..._len(2, [8, 1, 16, 2]), // trainer_spec: must be skipped
        ..._len(1, _piece('▁SPEED', -3.5, 1)),
        ..._len(1, _piece('BIRD', -7.25, 1)),
        ..._varint(9 << 3 | 0), ..._varint(300), // an unknown varint field
      ]);
      final pieces = parseSentencePieceModel(proto);
      expect(pieces.map((p) => p.piece), ['<blk>', '▁SPEED', 'BIRD']);
      expect(pieces[1].score, -3.5);
      expect(pieces[0].type, 3);
      expect(bpeVocabFromModel(proto), '<blk>\t0.0\n▁SPEED\t-3.5\nBIRD\t-7.25\n');
    });

    test('rejects something that is not a model', () {
      expect(() => parseSentencePieceModel(Uint8List.fromList([0xff, 0xff])), throwsFormatException);
      expect(() => parseSentencePieceModel(Uint8List(0)), throwsFormatException);
    });
  });

  group('hotwords', () {
    test('spoken words: digits one by one, runway sides, letters as phonetics', () {
      expect(spokenWords('speedbird 273'), ['SPEEDBIRD', 'TWO', 'SEVEN', 'THREE']);
      expect(spokenWords('runway 27R'), ['RUNWAY', 'TWO', 'SEVEN', 'RIGHT']);
      expect(spokenWords('runway 4L'), ['RUNWAY', 'FOUR', 'LEFT']);
      expect(spokenWords('n123ab'), ['NOVEMBER', 'ONE', 'TWO', 'THREE', 'ALPHA', 'BRAVO']);
      expect(spokenWords('sky dubai 308'), ['SKY', 'DUBAI', 'THREE', 'ZERO', 'EIGHT']);
      expect(spokenWords('  '), isEmpty);
    });

    test('per aircraft: full callsign, telephony alone, bare flight number; then phraseology', () {
      final h = buildHotwords(spoken: ['speedbird 273', 'ups 973'], extra: ['runway 27R']).split('/');
      expect(h, contains('SPEEDBIRD TWO SEVEN THREE :2.0'));
      expect(h, contains('SPEEDBIRD :1.5'));
      expect(h, contains('TWO SEVEN THREE :1.5'));
      expect(h, contains('UPS NINE SEVEN THREE :2.0'));
      expect(h, contains('RUNWAY TWO SEVEN RIGHT :1.5'));
      expect(h, contains('CLEARED TO LAND :1.0'));
      expect(h, contains('WHISKEY :1.0'));
      // every entry is "<UPPER WORDS> :<score>", the format sherpa-onnx's per-stream hotwords expect
      for (final l in h) {
        expect(l, matches(RegExp(r"^[A-Z' ]+ :\d+\.\d$")));
      }
    });

    test('no duplicates, a hard cap, and phraseology can be switched off', () {
      final h = buildHotwords(spoken: ['delta 1', 'delta 1'], phraseology: false).split('/');
      expect(h, ['DELTA ONE :2.0', 'DELTA :1.5']);
      final many = buildHotwords(spoken: [for (var i = 0; i < 500; i++) 'delta ${i + 100}'], o: const HotwordOptions(maxLines: 50));
      expect(many.split('/').length, 50);
    });
  });

  test('PCM16 little endian -> float in [-1, 1]', () {
    final b = ByteData(6)
      ..setInt16(0, 0, Endian.little)
      ..setInt16(2, 16384, Endian.little)
      ..setInt16(4, -32768, Endian.little);
    expect(pcm16ToFloat(b.buffer.asUint8List()), [0.0, 0.5, -1.0]);
    expect(pcm16ToFloat(Uint8List.fromList([1, 2, 3])).length, 1, reason: 'a trailing odd byte is ignored');
  });
}
