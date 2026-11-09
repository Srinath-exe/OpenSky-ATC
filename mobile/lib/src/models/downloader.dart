// Model delivery: fetch the files of a ModelSpec into <root>/<id>/<version>/ with progress, resume and SHA-256 checks.
//
//  - each file streams to `<name>.part`; an interrupted download resumes with an HTTP Range request (the bytes already
//    on disk are re-hashed first, so the final hash still covers the whole file)
//  - a file is only renamed into place after its SHA-256 matches the manifest; a mismatch deletes it
//  - `.installed.json` is written last: a model directory without it is never loaded
//  - other versions of the same model are deleted once the new one is installed
//
// Pure dart:io (no Flutter), so the unit tests run it against a local HTTP server.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

import 'manifest.dart';

class DownloadProgress {
  const DownloadProgress({required this.done, required this.total, required this.file, required this.fileIndex, required this.fileCount, this.bytesPerSecond = 0});

  final int done;
  final int total;
  final String file;
  final int fileIndex;
  final int fileCount;
  final double bytesPerSecond;

  double get fraction => total <= 0 ? 0 : (done / total).clamp(0.0, 1.0);
}

class ChecksumMismatch implements Exception {
  ChecksumMismatch(this.file, this.expected, this.actual);
  final String file;
  final String expected;
  final String actual;
  @override
  String toString() => 'Checksum mismatch for $file (expected ${expected.substring(0, 12)}…, got ${actual.substring(0, 12)}…)';
}

class DownloadCancelled implements Exception {
  @override
  String toString() => 'Download cancelled';
}

const _marker = '.installed.json';

class ModelDownloader {
  ModelDownloader({required this.root, HttpClient? client, this.retries = 3, this.retryDelay = const Duration(seconds: 2)})
      : _client = client ?? (HttpClient()..connectionTimeout = const Duration(seconds: 20));

  /// `<app support>/models`
  final Directory root;
  final HttpClient _client;
  final int retries;
  final Duration retryDelay;
  bool _cancelled = false;
  HttpClientRequest? _current;

  Directory dirFor(ModelSpec spec) => Directory('${root.path}/${spec.dirName}');

  /// Installed = the marker is there, it names this exact version, and every file has its manifest size.
  /// (Hashes are checked when the file is written; re-hashing ~70 MB at every launch would cost seconds on a phone.)
  Future<bool> isInstalled(ModelSpec spec) async {
    final dir = dirFor(spec);
    final m = File('${dir.path}/$_marker');
    if (!await m.exists()) return false;
    try {
      final j = jsonDecode(await m.readAsString()) as Map<String, dynamic>;
      if (j['id'] != spec.id || j['version'] != spec.version) return false;
      final hashes = (j['sha256'] as Map?)?.cast<String, dynamic>() ?? const {};
      for (final f in spec.files) {
        if (hashes[f.name] != f.sha256) return false;
        final file = File('${dir.path}/${f.name}');
        if (!await file.exists() || await file.length() != f.size) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Bytes already on disk for this model (finished files + partial downloads): lets the UI show "resume at 40%".
  Future<int> bytesOnDisk(ModelSpec spec) async {
    final dir = dirFor(spec);
    var n = 0;
    for (final f in spec.files) {
      final done = File('${dir.path}/${f.name}');
      final part = File('${dir.path}/${f.name}.part');
      if (await done.exists()) {
        n += await done.length();
      } else if (await part.exists()) {
        n += await part.length();
      }
    }
    return n;
  }

  void cancel() {
    _cancelled = true;
    _current?.abort(DownloadCancelled());
  }

  /// Download (or finish downloading) every file, verify, mark installed, prune other versions. Returns the directory.
  Future<Directory> install(ModelSpec spec, {void Function(DownloadProgress p)? onProgress}) async {
    _cancelled = false;
    final dir = dirFor(spec);
    await dir.create(recursive: true);
    final total = spec.totalBytes;
    final sizes = <String, int>{};
    for (final f in spec.files) {
      sizes[f.name] = 0;
    }
    final watch = Stopwatch()..start();
    final startBytes = await bytesOnDisk(spec);   // resumed bytes do not count towards the speed
    void report(String name, int idx) {
      final done = sizes.values.fold(0, (a, b) => a + b);
      final secs = watch.elapsedMilliseconds / 1000;
      final fresh = done - startBytes;
      onProgress?.call(DownloadProgress(done: done, total: total, file: name, fileIndex: idx, fileCount: spec.files.length, bytesPerSecond: secs > 0.5 && fresh > 0 ? fresh / secs : 0));
    }

    for (var i = 0; i < spec.files.length; i++) {
      final f = spec.files[i];
      final target = File('${dir.path}/${f.name}');
      if (await target.exists() && await target.length() == f.size && await _sha256File(target) == f.sha256) {
        sizes[f.name] = f.size;
        report(f.name, i);
        continue;
      }
      if (await target.exists()) await target.delete();
      var attempt = 0;
      while (true) {
        if (_cancelled) throw DownloadCancelled();
        try {
          await _fetch(f, dir, (n) {
            sizes[f.name] = n;
            report(f.name, i);
          });
          break;
        } on ChecksumMismatch {
          rethrow;
        } on DownloadCancelled {
          rethrow;
        } catch (e) {
          if (_cancelled) throw DownloadCancelled();
          attempt++;
          if (attempt > retries) rethrow;
          await Future<void>.delayed(retryDelay * attempt);
        }
      }
    }
    final marker = {
      'id': spec.id,
      'version': spec.version,
      'installedAt': DateTime.now().toUtc().toIso8601String(),
      'sha256': {for (final f in spec.files) f.name: f.sha256},
      'spec': spec.toJson(),
    };
    await File('${dir.path}/$_marker').writeAsString(jsonEncode(marker), flush: true);
    await pruneOtherVersions(spec);
    return dir;
  }

  /// Delete other versions of this model id (and leftovers of models no longer in the manifest are left to the caller).
  Future<void> pruneOtherVersions(ModelSpec spec) async {
    final idDir = dirFor(spec).parent;
    if (!await idDir.exists()) return;
    await for (final e in idDir.list()) {
      if (e is Directory && e.path != dirFor(spec).path) {
        try {
          await e.delete(recursive: true);
        } catch (_) {/* in use or already gone */}
      }
    }
  }

  Future<void> _fetch(ModelFile f, Directory dir, void Function(int bytesSoFar) onBytes) async {
    final part = File('${dir.path}/${f.name}.part');
    var have = await part.exists() ? await part.length() : 0;
    if (have > f.size) {
      await part.delete();
      have = 0;
    }
    final req = await _client.getUrl(Uri.parse(f.url));
    _current = req;
    req.followRedirects = true;
    req.maxRedirects = 8;
    if (have > 0) req.headers.set(HttpHeaders.rangeHeader, 'bytes=$have-');
    final res = await req.close();
    if (res.statusCode == 416 && have == f.size) {
      await res.drain<void>();     // the part file already holds every byte
    } else if (res.statusCode == 206 && have > 0) {
      // resume: keep the bytes we have
    } else if (res.statusCode == 200) {
      have = 0;                    // the server ignored the Range header: start over
    } else {
      await res.drain<void>();
      throw HttpException('HTTP ${res.statusCode} for ${f.name}');
    }

    // hash = (bytes already on disk) + (incoming bytes)
    final digest = _DigestSink();
    final hasher = sha256.startChunkedConversion(digest);
    if (have > 0) {
      await for (final chunk in part.openRead(0, have)) {
        hasher.add(chunk);
      }
    } else if (await part.exists()) {
      await part.delete();
    }
    onBytes(have);
    if (res.statusCode != 416) {
      final sink = part.openWrite(mode: FileMode.append);
      var n = have;
      var lastReport = 0;
      try {
        await for (final chunk in res) {
          if (_cancelled) throw DownloadCancelled();
          sink.add(chunk);
          hasher.add(chunk);
          n += chunk.length;
          if (n - lastReport > 256 * 1024 || n == f.size) {
            lastReport = n;
            onBytes(n);
          }
          if (n > f.size) throw HttpException('${f.name}: more bytes than the manifest says (${f.size})');
        }
      } finally {
        await sink.flush();
        await sink.close();
      }
      onBytes(n);
      if (n != f.size) throw HttpException('${f.name}: connection closed at $n of ${f.size} bytes');
    }
    hasher.close();
    final got = digest.value.toString();
    if (got != f.sha256) {
      await part.delete();
      throw ChecksumMismatch(f.name, f.sha256, got);
    }
    await part.rename('${dir.path}/${f.name}');
    _current = null;
  }
}

Future<String> _sha256File(File f) async => (await sha256.bind(f.openRead()).first).toString();

class _DigestSink implements Sink<Digest> {
  Digest? _d;
  Digest get value => _d!;
  @override
  void add(Digest data) => _d = data;
  @override
  void close() {}
}
