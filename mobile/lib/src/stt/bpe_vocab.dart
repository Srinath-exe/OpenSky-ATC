// Turn a SentencePiece `bpe.model` into the `bpe.vocab` text file sherpa-onnx needs for hotwords.
//
// sherpa-onnx encodes each hotword into the model's own sub-word tokens before boosting them in the beam search, and
// for that it wants "<piece>\t<score>" lines (what sherpa-onnx's scripts/export_bpe_vocab.py writes with the Python
// sentencepiece package). The model repositories ship bpe.model, a protobuf, so the app converts it on device instead
// of fetching a second, unofficial file. The format is small:
//
//   ModelProto      { repeated SentencePiece pieces = 1; ...other fields we skip... }
//   SentencePiece   { string piece = 1; float score = 2; Type type = 3; }

import 'dart:convert';
import 'dart:typed_data';

class SentencePiece {
  const SentencePiece(this.piece, this.score, this.type);
  final String piece;
  final double score;
  final int type; // 1 normal, 2 unknown, 3 control, 4 user defined, 5 unused, 6 byte
}

List<SentencePiece> parseSentencePieceModel(Uint8List bytes) {
  final r = _Reader(bytes);
  final out = <SentencePiece>[];
  while (!r.done) {
    final key = r.varint();
    final field = key >> 3, wire = key & 7;
    if (field == 1 && wire == 2) {
      final len = r.varint();
      out.add(_piece(_Reader(r.bytes(len))));
    } else {
      r.skip(wire);
    }
  }
  if (out.isEmpty) throw const FormatException('not a SentencePiece model (no pieces)');
  return out;
}

SentencePiece _piece(_Reader r) {
  var piece = '';
  var score = 0.0;
  var type = 1;
  while (!r.done) {
    final key = r.varint();
    final field = key >> 3, wire = key & 7;
    if (field == 1 && wire == 2) {
      piece = utf8.decode(r.bytes(r.varint()));
    } else if (field == 2 && wire == 5) {
      score = r.float32();
    } else if (field == 3 && wire == 0) {
      type = r.varint();
    } else {
      r.skip(wire);
    }
  }
  return SentencePiece(piece, score, type);
}

/// Same text as sherpa-onnx's export_bpe_vocab.py: one `piece<TAB>score` line per piece, in id order.
String bpeVocabFromModel(Uint8List bytes) {
  final b = StringBuffer();
  for (final p in parseSentencePieceModel(bytes)) {
    b.write(p.piece);
    b.write('\t');
    b.write(_fmt(p.score));
    b.write('\n');
  }
  return b.toString();
}

// Python prints 0.0 for zero scores; Dart prints "0.0" too, and the float32 -> double widening matches
// sentencepiece's GetScore(), so the two files are byte-identical.
String _fmt(double v) => v.toString();

class _Reader {
  _Reader(this._b) : _d = ByteData.sublistView(_b);
  final Uint8List _b;
  final ByteData _d;
  int _i = 0;

  bool get done => _i >= _b.length;

  int varint() {
    var shift = 0;
    var v = 0;
    while (true) {
      if (_i >= _b.length) throw const FormatException('truncated varint');
      final byte = _b[_i++];
      v |= (byte & 0x7f) << shift;
      if (byte & 0x80 == 0) return v;
      shift += 7;
      if (shift > 63) throw const FormatException('varint too long');
    }
  }

  Uint8List bytes(int n) {
    if (_i + n > _b.length) throw const FormatException('truncated field');
    final out = Uint8List.sublistView(_b, _i, _i + n);
    _i += n;
    return out;
  }

  double float32() {
    if (_i + 4 > _b.length) throw const FormatException('truncated float');
    final v = _d.getFloat32(_i, Endian.little);
    _i += 4;
    return v;
  }

  void skip(int wire) {
    switch (wire) {
      case 0:
        varint();
      case 1:
        bytes(8);
      case 2:
        bytes(varint());
      case 5:
        bytes(4);
      default:
        throw FormatException('unsupported wire type $wire');
    }
  }
}
