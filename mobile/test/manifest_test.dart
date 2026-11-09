import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/models/manifest.dart';

Map<String, dynamic> _file(String role, {String? name, String url = 'https://example.org/x', String sha = '', int size = 10}) => {
      'role': role,
      'name': name ?? '$role.onnx',
      'url': url,
      'sha256': sha.isEmpty ? 'a' * 64 : sha,
      'size': size,
    };

Map<String, dynamic> _spec({List<Map<String, dynamic>>? files, String kind = 'transducer', bool hotwords = false}) => {
      'id': 'm',
      'name': 'M',
      'version': '1',
      'kind': kind,
      'hotwords': hotwords,
      'files': files ?? [_file('encoder'), _file('decoder'), _file('joiner'), _file('tokens', name: 'tokens.txt')],
    };

String _manifest(List<Map<String, dynamic>> models, {String active = 'm', int schema = 1}) => jsonEncode({'schema': schema, 'active': active, 'models': models});

void main() {
  test('the bundled manifest parses, pins every file and its active model can do hotwords', () {
    final m = ModelManifest.parse(File('assets/stt_models.json').readAsStringSync());
    final a = m.activeModel;
    expect(a.kind, ModelKind.transducer);
    expect(a.hotwords, isTrue);
    expect(a.file('bpe_model'), isNotNull);
    for (final s in m.models) {
      for (final f in s.files) {
        expect(f.sha256, matches(RegExp(r'^[0-9a-f]{64}$')));
        expect(f.size, greaterThan(0));
        // pinned to a commit, so the bytes behind the URL cannot change under the hash
        expect(f.url, matches(RegExp(r'^https://huggingface\.co/.+/resolve/[0-9a-f]{40}/')));
      }
    }
    expect(a.totalBytes, inInclusiveRange(10e6, 150e6));
  });

  test('a valid spec round-trips through JSON', () {
    final s = ModelSpec.fromJson(_spec());
    final again = ModelSpec.fromJson(jsonDecode(jsonEncode(s.toJson())) as Map<String, dynamic>);
    expect(again.id, 'm');
    expect(again.files.map((f) => f.name), s.files.map((f) => f.name));
    expect(again.totalBytes, 40);
    expect(again.dirName, 'm/1');
  });

  test('rejects malformed entries', () {
    expect(() => ModelSpec.fromJson(_spec(files: [_file('encoder', sha: 'abc')])), throwsFormatException);
    expect(() => ModelSpec.fromJson(_spec(files: [_file('encoder', url: 'http://plain.example/x'), _file('decoder'), _file('joiner'), _file('tokens', name: 't')])), throwsFormatException);
    expect(() => ModelSpec.fromJson(_spec(files: [_file('encoder', name: '../escape'), _file('decoder'), _file('joiner'), _file('tokens', name: 't')])), throwsFormatException);
    expect(() => ModelSpec.fromJson(_spec(files: [_file('encoder'), _file('decoder')])), throwsFormatException, reason: 'joiner + tokens missing');
    expect(() => ModelSpec.fromJson(_spec(hotwords: true)), throwsFormatException, reason: 'hotwords need bpe_model');
    expect(() => ModelSpec.fromJson(_spec(kind: 'whisper')), throwsFormatException);
    expect(() => ModelSpec.fromJson(_spec(files: [_file('encoder'), _file('decoder', name: 'encoder.onnx'), _file('joiner'), _file('tokens')])), throwsFormatException, reason: 'duplicate names');
  });

  test('manifest level checks', () {
    expect(() => ModelManifest.parse(_manifest([_spec()], active: 'other')), throwsFormatException);
    expect(() => ModelManifest.parse(_manifest([_spec()], schema: 2)), throwsFormatException);
    expect(ModelManifest.parse(_manifest([_spec()])).activeModel.id, 'm');
  });

  test('version strings become safe directory names', () {
    final s = ModelSpec.fromJson({..._spec(), 'id': 'zip/former', 'version': '2023 06'});
    expect(s.dirName, 'zip_former/2023_06');
  });
}
