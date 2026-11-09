// OpenATC for phones: the web game in a WebView + on-device speech-to-text behind a JS bridge.
//
//   first run      ModelScreen   downloads the pinned speech model (progress, resume, SHA-256)
//   then           GameScreen    the live game; push-to-talk in the page -> native mic -> sherpa-onnx -> transcript
//
// Build-time settings: --dart-define=GAME_URL=https://... (default the live site).

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'src/models/downloader.dart';
import 'src/models/manifest.dart';
import 'src/ui/game_screen.dart';
import 'src/ui/model_screen.dart';
import 'src/ui/theme.dart';

const String kGameUrl = String.fromEnvironment('GAME_URL', defaultValue: 'https://openatc.aeon-labs.site/');
const String kAppVersion = String.fromEnvironment('APP_VERSION', defaultValue: '1.0.0');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final manifest = ModelManifest.parse(await rootBundle.loadString('assets/stt_models.json'));
  final support = await getApplicationSupportDirectory();
  final downloader = ModelDownloader(root: Directory('${support.path}/models'));
  runApp(OpenAtcApp(manifest: manifest, downloader: downloader));
}

class OpenAtcApp extends StatelessWidget {
  const OpenAtcApp({super.key, required this.manifest, required this.downloader});
  final ModelManifest manifest;
  final ModelDownloader downloader;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'OpenATC',
      debugShowCheckedModeBanner: false,
      theme: atcTheme(),
      home: _Start(manifest: manifest, downloader: downloader),
    );
  }
}

/// Model installed -> straight into the game; otherwise the first-run download screen.
class _Start extends StatefulWidget {
  const _Start({required this.manifest, required this.downloader});
  final ModelManifest manifest;
  final ModelDownloader downloader;

  @override
  State<_Start> createState() => _StartState();
}

class _StartState extends State<_Start> {
  bool? _installed;
  bool _skipped = false;

  @override
  void initState() {
    super.initState();
    widget.downloader.isInstalled(widget.manifest.activeModel).then((v) => setState(() => _installed = v));
  }

  @override
  Widget build(BuildContext context) {
    final spec = widget.manifest.activeModel;
    if (_installed == null) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (_installed! || _skipped) {
      return GameScreen(
        url: kGameUrl,
        appVersion: kAppVersion,
        spec: _installed! ? spec : null,
        modelDir: widget.downloader.dirFor(spec).path,
        onManageModel: () => setState(() {
          _installed = false;
          _skipped = false;
        }),
      );
    }
    return ModelScreen(
      spec: spec,
      downloader: widget.downloader,
      onInstalled: () => setState(() => _installed = true),
      onSkip: () => setState(() => _skipped = true),
    );
  }
}
