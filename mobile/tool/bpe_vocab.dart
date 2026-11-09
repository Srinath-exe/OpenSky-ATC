// bpe.model -> bpe.vocab with the app's converter (what the phone does before the first hotword run).
//   dart run tool/bpe_vocab.dart path/to/bpe.model > bpe.vocab
import 'dart:io';

import 'package:openatc/src/stt/bpe_vocab.dart';

void main(List<String> a) => stdout.write(bpeVocabFromModel(File(a.single).readAsBytesSync()));
