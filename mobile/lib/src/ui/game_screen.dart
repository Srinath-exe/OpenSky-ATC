// The live game in a WebView, plus the native half of push-to-talk.
//
// The page finds `window.OpenATCNative` (a JavaScriptChannel, present only when a speech model is installed), selects
// the "Phone" recogniser, and sends start/stop on PTT. Transcripts come back as `openatc-native` events. A small chip
// in the corner shows the on-device speech-to-text latency of the last transmission.

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import '../audio/mic.dart';
import '../bridge/protocol.dart';
import '../bridge/voice_bridge.dart';
import '../models/manifest.dart';
import '../stt/stt_engine.dart';
import '../stt/stt_service.dart';
import 'theme.dart';

/// The game needs ~1280 CSS px of width (src/game/HoldingScreen). On a phone the page is laid out at that width and
/// scaled to fit, and the "desktop required" notice is pre-dismissed.
const int kLayoutWidth = int.fromEnvironment('LAYOUT_WIDTH', defaultValue: 1280);

String _pageSetupJs() => '''
(function(){
  try { localStorage.setItem('skycontrol_allow_narrow','1'); } catch(e) {}
  var w = $kLayoutWidth;
  if (w > 0 && window.innerWidth < w) {
    var m = document.querySelector('meta[name=viewport]');
    if (!m) { m = document.createElement('meta'); m.name = 'viewport'; document.head.appendChild(m); }
    m.setAttribute('content', 'width=' + w + ', viewport-fit=cover');
  }
})();''';

class GameScreen extends StatefulWidget {
  const GameScreen({super.key, required this.url, required this.appVersion, required this.spec, required this.modelDir, required this.onManageModel});
  final String url;
  final String appVersion;

  /// null = no model installed: the bridge is not offered and the page uses its own recognisers.
  final ModelSpec? spec;
  final String modelDir;
  final VoidCallback onManageModel;

  @override
  State<GameScreen> createState() => _GameScreenState();
}

class _GameScreenState extends State<GameScreen> {
  late final WebViewController _web;
  VoiceBridge? _bridge;
  IsolateStt? _stt;
  final RecordMic _mic = RecordMic();
  UtteranceStats? _last;
  final List<double> _recent = [];
  bool _listening = false;
  String _status = '';
  int _progress = 0;
  Timer? _hideLast;

  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations([DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]);
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    _web = WebViewController(onPermissionRequest: (r) {
      // only the page's own fallback recogniser (Moonshine in the browser) asks; the app's recogniser does not need it
      if (r.types.contains(WebViewPermissionResourceType.microphone)) {
        r.grant();
      } else {
        r.deny();
      }
    });
    unawaited(_setup());
  }

  Future<void> _setup() async {
    final web = _web;
    await web.setJavaScriptMode(JavaScriptMode.unrestricted);
    await web.setBackgroundColor(AtcColors.bg);
    final ua = await web.getUserAgent();
    await web.setUserAgent('${ua ?? ''} OpenATCApp/${widget.appVersion}'.trim());
    if (web.platform is AndroidWebViewController) {
      final a = web.platform as AndroidWebViewController;
      await a.setMediaPlaybackRequiresUserGesture(false);   // pilot voice / radio audio
      await a.setUseWideViewPort(true);
    }
    await web.setNavigationDelegate(NavigationDelegate(
      onProgress: (p) => mounted ? setState(() => _progress = p) : null,
      onPageStarted: (_) => _bridge?.reset(),
      onPageFinished: (_) async {
        await web.runJavaScript(_pageSetupJs());
        await _bridge?.announce();
      },
      onWebResourceError: (e) {
        if (e.isForMainFrame ?? true) setState(() => _status = 'Could not load the game: ${e.description}');
      },
    ));
    if (widget.spec != null) {
      final bridge = _bridge = VoiceBridge(
        runJs: web.runJavaScript,
        mic: _mic,
        appVersion: widget.appVersion,
        platform: Platform.operatingSystem,
        onListening: (l) => mounted ? setState(() => _listening = l) : null,
        onUtterance: _onUtterance,
      );
      await web.addJavaScriptChannel(kChannelName, onMessageReceived: (m) => bridge.handle(m.message));
      unawaited(_loadModel(bridge));
    }
    await web.loadRequest(Uri.parse(widget.url));
  }

  Future<void> _loadModel(VoiceBridge bridge) async {
    final spec = widget.spec!;
    setState(() => _status = 'Loading speech model…');
    try {
      final threads = Platform.numberOfProcessors >= 6 ? 2 : 1;
      final stt = _stt = await IsolateStt.start(spec, widget.modelDir, options: SttOptions(threads: threads));
      bridge.attach(stt, model: {'id': spec.id, 'name': spec.name, 'version': spec.version, 'loadMs': stt.loadMs, 'threads': threads});
      if (mounted) setState(() => _status = 'Speech model ready in ${(stt.loadMs / 1000).toStringAsFixed(1)} s');
      Timer(const Duration(seconds: 3), () => mounted ? setState(() => _status = '') : null);
    } catch (e) {
      bridge.attach(null, error: e.toString());
      if (mounted) setState(() => _status = e.toString());
    }
  }

  void _onUtterance(UtteranceStats s) {
    if (!mounted) return;
    setState(() {
      _last = s;
      _recent.add(s.ms);
      if (_recent.length > 20) _recent.removeAt(0);
    });
    _hideLast?.cancel();
    _hideLast = Timer(const Duration(seconds: 8), () => mounted ? setState(() => _last = null) : null);
  }

  @override
  void dispose() {
    _hideLast?.cancel();
    unawaited(_stt?.dispose());
    unawaited(_mic.dispose());
    SystemChrome.setPreferredOrientations([]);
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    super.dispose();
  }

  double get _p50 {
    if (_recent.isEmpty) return 0;
    final s = [..._recent]..sort();
    return s[s.length ~/ 2];
  }

  void _menu() {
    final spec = widget.spec;
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AtcColors.surface,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(spec == null ? 'No speech model installed' : spec.name, style: const TextStyle(fontWeight: FontWeight.w600)),
            if (spec != null) Text('version ${spec.version} · ${(spec.totalBytes / 1e6).toStringAsFixed(0)} MB · ${spec.license}', style: const TextStyle(color: AtcColors.muted, fontSize: 13)),
            if (_stt != null) Text('loaded in ${_stt!.loadMs} ms · hotwords ${_stt!.supportsHotwords ? 'on' : 'off'}', style: const TextStyle(color: AtcColors.muted, fontSize: 13)),
            if (_recent.isNotEmpty) Text('release → text: median ${_p50.toStringAsFixed(0)} ms over the last ${_recent.length}', style: const TextStyle(color: AtcColors.muted, fontSize: 13)),
            const SizedBox(height: 12),
            Wrap(spacing: 8, children: [
              FilledButton.tonal(onPressed: () { Navigator.pop(ctx); _web.reload(); }, child: const Text('Reload game')),
              FilledButton.tonal(onPressed: () { Navigator.pop(ctx); widget.onManageModel(); }, child: Text(spec == null ? 'Download speech model' : 'Speech model…')),
            ]),
          ]),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final last = _last;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (await _web.canGoBack()) {
          await _web.goBack();
        } else {
          _menu();
        }
      },
      child: Scaffold(
        backgroundColor: AtcColors.bg,
        body: Stack(children: [
          Positioned.fill(child: WebViewWidget(controller: _web)),
          if (_progress < 100) Positioned(top: 0, left: 0, right: 0, child: LinearProgressIndicator(value: _progress / 100, minHeight: 2, color: AtcColors.accent, backgroundColor: Colors.transparent)),
          Positioned(
            right: 6,
            top: 6,
            child: GestureDetector(
              onTap: _menu,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 150),
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: (_listening ? AtcColors.accent : AtcColors.raise).withValues(alpha: .88),
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: AtcColors.line),
                ),
                child: Text(
                  _listening
                      ? 'on-device · listening'
                      : last != null
                          ? 'on-device STT ${last.ms.toStringAsFixed(0)} ms · RTF ${last.rtf.toStringAsFixed(2)}'
                          : _status.isNotEmpty
                              ? _status
                              : widget.spec == null ? 'no speech model' : 'on-device STT',
                  style: TextStyle(fontSize: 11, color: _listening ? Colors.black : AtcColors.text, fontFeatures: const [FontFeature.tabularFigures()]),
                ),
              ),
            ),
          ),
        ]),
      ),
    );
  }
}
