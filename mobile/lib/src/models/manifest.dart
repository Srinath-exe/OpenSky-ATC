// The speech-model manifest: which on-device model the app uses, where each file comes from and what it must hash to.
//
// The manifest ships inside the app (assets/stt_models.json), so the SHA-256 of every file is pinned at build time: a
// tampered or truncated download can never be loaded. Updating a model = add an entry with a new `version` (or a new
// `id`), point `active` at it, ship the app. Installed models live in <app support>/models/<id>/<version>/, so two
// versions never mix and the old one is deleted once the new one verifies.

import 'dart:convert';

/// One file of a model: what it is for (encoder / decoder / joiner / tokens / bpe_model ...), where to fetch it, and the
/// exact bytes expected.
class ModelFile {
  const ModelFile({required this.role, required this.name, required this.url, required this.sha256, required this.size});

  final String role;
  final String name;
  final String url;
  final String sha256;
  final int size;

  factory ModelFile.fromJson(Map<String, dynamic> j) {
    final f = ModelFile(
      role: _str(j, 'role'),
      name: _str(j, 'name'),
      url: _str(j, 'url'),
      sha256: _str(j, 'sha256').toLowerCase(),
      size: (j['size'] as num?)?.toInt() ?? -1,
    );
    if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(f.sha256)) throw FormatException('bad sha256 for ${f.name}');
    if (f.size <= 0) throw FormatException('bad size for ${f.name}');
    if (f.name.contains('/') || f.name.contains('\\') || f.name.startsWith('.')) throw FormatException('bad file name ${f.name}');
    if (!f.url.startsWith('https://')) throw FormatException('model files are fetched over https only: ${f.url}');
    return f;
  }

  Map<String, dynamic> toJson() => {'role': role, 'name': name, 'url': url, 'sha256': sha256, 'size': size};
}

/// The kinds of recogniser the app knows how to run.
///  - `transducer`: a streaming zipformer transducer (partials while you talk, hotwords / contextual biasing)
///  - `moonshine`: an offline Moonshine model (transcribes on release, no hotwords)
enum ModelKind { transducer, moonshine }

class ModelSpec {
  const ModelSpec({
    required this.id,
    required this.name,
    required this.version,
    required this.kind,
    required this.files,
    this.license = '',
    this.source = '',
    this.sampleRate = 16000,
    this.hotwords = false,
    this.modelType = '',
    this.notes = '',
  });

  final String id;
  final String name;
  final String version;
  final ModelKind kind;
  final List<ModelFile> files;
  final String license;
  final String source;
  final int sampleRate;

  /// The model can be biased towards words given at run time (callsigns, phraseology).
  final bool hotwords;

  /// sherpa-onnx `model_type` hint (e.g. 'zipformer2'); empty = let sherpa-onnx read it from the model metadata.
  final String modelType;
  final String notes;

  int get totalBytes => files.fold(0, (s, f) => s + f.size);

  ModelFile? file(String role) {
    for (final f in files) {
      if (f.role == role) return f;
    }
    return null;
  }

  /// Directory name for this exact version (safe for a path segment).
  String get dirName => '${_safe(id)}/${_safe(version)}';

  factory ModelSpec.fromJson(Map<String, dynamic> j) {
    final kindName = _str(j, 'kind');
    final kind = ModelKind.values.where((k) => k.name == kindName).firstOrNull;
    if (kind == null) throw FormatException('unknown model kind $kindName');
    final files = ((j['files'] as List?) ?? const []).map((e) => ModelFile.fromJson(e as Map<String, dynamic>)).toList();
    final spec = ModelSpec(
      id: _str(j, 'id'),
      name: _str(j, 'name'),
      version: _str(j, 'version'),
      kind: kind,
      files: files,
      license: (j['license'] as String?) ?? '',
      source: (j['source'] as String?) ?? '',
      sampleRate: (j['sampleRate'] as num?)?.toInt() ?? 16000,
      hotwords: (j['hotwords'] as bool?) ?? false,
      modelType: (j['modelType'] as String?) ?? '',
      notes: (j['notes'] as String?) ?? '',
    );
    final need = switch (kind) {
      ModelKind.transducer => const ['encoder', 'decoder', 'joiner', 'tokens'],
      ModelKind.moonshine => const ['encoder', 'merged_decoder', 'tokens'],
    };
    for (final r in need) {
      if (spec.file(r) == null) throw FormatException('${spec.id}: missing $r file');
    }
    if (spec.hotwords && spec.file('bpe_model') == null) throw FormatException('${spec.id}: hotwords need the bpe_model file');
    final names = files.map((f) => f.name).toSet();
    if (names.length != files.length) throw FormatException('${spec.id}: duplicate file names');
    return spec;
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'version': version,
        'kind': kind.name,
        'license': license,
        'source': source,
        'sampleRate': sampleRate,
        'hotwords': hotwords,
        if (modelType.isNotEmpty) 'modelType': modelType,
        if (notes.isNotEmpty) 'notes': notes,
        'files': files.map((f) => f.toJson()).toList(),
      };
}

class ModelManifest {
  const ModelManifest({required this.schema, required this.active, required this.models});

  final int schema;
  final String active;
  final List<ModelSpec> models;

  ModelSpec get activeModel => models.firstWhere((m) => m.id == active);

  factory ModelManifest.parse(String text) {
    final j = jsonDecode(text) as Map<String, dynamic>;
    final schema = (j['schema'] as num?)?.toInt() ?? 0;
    if (schema != 1) throw FormatException('unsupported manifest schema $schema');
    final models = ((j['models'] as List?) ?? const []).map((e) => ModelSpec.fromJson(e as Map<String, dynamic>)).toList();
    final active = _str(j, 'active');
    if (!models.any((m) => m.id == active)) throw FormatException('active model $active is not in the manifest');
    return ModelManifest(schema: schema, active: active, models: models);
  }
}

String _str(Map<String, dynamic> j, String k) {
  final v = j[k];
  if (v is! String || v.isEmpty) throw FormatException('missing "$k"');
  return v;
}

String _safe(String s) => s.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
