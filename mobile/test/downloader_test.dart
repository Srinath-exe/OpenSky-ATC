import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/models/downloader.dart';
import 'package:openatc/src/models/manifest.dart';

/// A tiny file server with Range support that records what it was asked for.
class _Server {
  _Server(this.files);
  final Map<String, Uint8List> files;
  late HttpServer _s;
  final List<String?> ranges = [];
  bool ignoreRange = false;

  /// Close the connection after this many bytes of the next response (simulates a dropped download).
  int? dropAfter;
  Uint8List? corrupt;

  String url(String name) => 'https://127.0.0.1:${_s.port}/$name';

  Future<void> start() async {
    _s = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _s.listen((req) async {
      final name = req.uri.path.substring(1);
      final body = corrupt ?? files[name];
      ranges.add(req.headers.value(HttpHeaders.rangeHeader));
      if (body == null) {
        req.response.statusCode = 404;
        await req.response.close();
        return;
      }
      var start = 0;
      final r = req.headers.value(HttpHeaders.rangeHeader);
      if (r != null && !ignoreRange) {
        start = int.parse(RegExp(r'bytes=(\d+)-').firstMatch(r)!.group(1)!);
        if (start >= body.length) {
          req.response.statusCode = 416;
          await req.response.close();
          return;
        }
        req.response.statusCode = 206;
        req.response.headers.set(HttpHeaders.contentRangeHeader, 'bytes $start-${body.length - 1}/${body.length}');
      }
      var part = body.sublist(start);
      final drop = dropAfter;
      if (drop != null) {
        dropAfter = null;
        part = part.sublist(0, min(drop, part.length));
        req.response.contentLength = body.length - start;
        final socket = await req.response.detachSocket();   // headers promise the whole file...
        socket.add(part);                                    // ...but only part of it arrives
        await socket.flush();
        socket.destroy();
        return;
      }
      req.response.contentLength = part.length;
      req.response.add(part);
      await req.response.close();
    });
  }

  Future<void> stop() => _s.close(force: true);
}

Uint8List _bytes(int n, int seed) {
  final r = Random(seed);
  return Uint8List.fromList(List.generate(n, (_) => r.nextInt(256)));
}

ModelSpec _spec(_Server s, {String version = '1'}) => ModelSpec(
      id: 'm',
      name: 'test',
      version: version,
      kind: ModelKind.transducer,
      files: [
        for (final e in s.files.entries) ModelFile(role: e.key.split('.').first, name: e.key, url: s.url(e.key), sha256: sha256.convert(e.value).toString(), size: e.value.length),
      ],
    );

/// The manifest only accepts https URLs; this client rewrites them to http for the local test server, so the pinned-https rule can stay strict in the app.
class _Rewrite implements HttpClient {
  _Rewrite(this._inner);
  final HttpClient _inner;
  @override
  Future<HttpClientRequest> getUrl(Uri url) => _inner.getUrl(url.replace(scheme: 'http'));
  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

void main() {
  late Directory tmp;
  late _Server server;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('dl_test');
    server = _Server({'encoder.onnx': _bytes(700 * 1024, 1), 'decoder.onnx': _bytes(90 * 1024, 2), 'tokens.txt': _bytes(3000, 3)});
    await server.start();
  });

  tearDown(() async {
    await server.stop();
    await tmp.delete(recursive: true);
  });

  ModelDownloader dl() => ModelDownloader(root: Directory('${tmp.path}/models'), client: _Rewrite(HttpClient()), retries: 2, retryDelay: Duration.zero);

  test('downloads, verifies, reports monotonic progress and marks the model installed', () async {
    final spec = _spec(server);
    final d = dl();
    expect(await d.isInstalled(spec), isFalse);
    final seen = <DownloadProgress>[];
    final dir = await d.install(spec, onProgress: seen.add);
    expect(await d.isInstalled(spec), isTrue);
    for (final f in spec.files) {
      expect(await File('${dir.path}/${f.name}').readAsBytes(), server.files[f.name]);
      expect(File('${dir.path}/${f.name}.part').existsSync(), isFalse);
    }
    expect(seen.last.done, spec.totalBytes);
    expect(seen.last.fraction, 1.0);
    for (var i = 1; i < seen.length; i++) {
      expect(seen[i].done, greaterThanOrEqualTo(seen[i - 1].done));
    }
  });

  test('resumes a partial file with a Range request instead of starting over', () async {
    final spec = _spec(server);
    final d = dl();
    final dir = d.dirFor(spec)..createSync(recursive: true);
    final enc = server.files['encoder.onnx']!;
    File('${dir.path}/encoder.onnx.part').writeAsBytesSync(enc.sublist(0, 300 * 1024));
    expect(await d.bytesOnDisk(spec), 300 * 1024);
    await d.install(spec);
    expect(server.ranges.first, 'bytes=${300 * 1024}-');
    expect(await File('${dir.path}/encoder.onnx').readAsBytes(), enc);
    expect(await d.isInstalled(spec), isTrue);
  });

  test('a dropped connection is retried from where it stopped', () async {
    final spec = _spec(server);
    server.dropAfter = 200 * 1024;
    final d = dl();
    await d.install(spec);
    expect(server.ranges.take(2).toList(), [null, 'bytes=${200 * 1024}-']);
    expect(await d.isInstalled(spec), isTrue);
  });

  test('a server that ignores Range restarts the file and still verifies', () async {
    final spec = _spec(server);
    server.ignoreRange = true;
    final d = dl();
    final dir = d.dirFor(spec)..createSync(recursive: true);
    File('${dir.path}/encoder.onnx.part').writeAsBytesSync(List.filled(1000, 7));   // junk that must be discarded
    await d.install(spec);
    expect(await File('${dir.path}/encoder.onnx').readAsBytes(), server.files['encoder.onnx']);
  });

  test('wrong bytes fail the SHA-256 check, are deleted and nothing is marked installed', () async {
    final spec = _spec(server);
    server.corrupt = _bytes(700 * 1024, 99);
    final d = dl();
    await expectLater(d.install(spec), throwsA(isA<ChecksumMismatch>()));
    expect(File('${d.dirFor(spec).path}/encoder.onnx.part').existsSync(), isFalse);
    expect(File('${d.dirFor(spec).path}/encoder.onnx').existsSync(), isFalse);
    expect(await d.isInstalled(spec), isFalse);
  });

  test('a changed manifest version is a different install; the old version is pruned', () async {
    final d = dl();
    final v1 = _spec(server, version: '1');
    await d.install(v1);
    final v2 = _spec(server, version: '2');
    expect(await d.isInstalled(v2), isFalse);
    await d.install(v2);
    expect(await d.isInstalled(v2), isTrue);
    expect(d.dirFor(v1).existsSync(), isFalse);
  });

  test('an installed file that no longer matches the manifest size is not trusted', () async {
    final spec = _spec(server);
    final d = dl();
    final dir = await d.install(spec);
    File('${dir.path}/tokens.txt').writeAsBytesSync([1, 2, 3]);
    expect(await d.isInstalled(spec), isFalse);
    await d.install(spec);   // repairs only that file
    expect(await d.isInstalled(spec), isTrue);
  });

  test('cancel stops the download and keeps the partial file for later', () async {
    final big = _Server({'encoder.onnx': _bytes(8 * 1024 * 1024, 5)});
    await big.start();
    final spec = _spec(big);
    final d = dl();
    final f = d.install(spec, onProgress: (p) {
      if (p.done > 512 * 1024) d.cancel();
    });
    await expectLater(f, throwsA(isA<DownloadCancelled>()));
    expect(await d.bytesOnDisk(spec), greaterThan(0));
    expect(await d.isInstalled(spec), isFalse);
    await big.stop();
  });
}
