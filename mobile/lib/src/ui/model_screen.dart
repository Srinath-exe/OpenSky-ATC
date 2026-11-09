// First run: download the on-device speech model. Shows size, licence and source up front; progress with speed and
// time left; survives the app being killed (the .part files resume); refuses files whose SHA-256 is not the pinned one.

import 'dart:async';

import 'package:flutter/material.dart';

import '../models/downloader.dart';
import '../models/manifest.dart';
import 'theme.dart';

class ModelScreen extends StatefulWidget {
  const ModelScreen({super.key, required this.spec, required this.downloader, required this.onInstalled, required this.onSkip});
  final ModelSpec spec;
  final ModelDownloader downloader;
  final VoidCallback onInstalled;
  final VoidCallback onSkip;

  @override
  State<ModelScreen> createState() => _ModelScreenState();
}

class _ModelScreenState extends State<ModelScreen> {
  DownloadProgress? _p;
  bool _running = false;
  String? _error;
  int _resumeBytes = 0;

  @override
  void initState() {
    super.initState();
    widget.downloader.bytesOnDisk(widget.spec).then((b) => mounted ? setState(() => _resumeBytes = b) : null);
  }

  Future<void> _go() async {
    setState(() {
      _running = true;
      _error = null;
    });
    try {
      await widget.downloader.install(widget.spec, onProgress: (p) => mounted ? setState(() => _p = p) : null);
      if (mounted) widget.onInstalled();
    } on DownloadCancelled {
      if (mounted) setState(() => _running = false);
    } catch (e) {
      final b = await widget.downloader.bytesOnDisk(widget.spec);
      if (mounted) {
        setState(() {
          _running = false;
          _error = e.toString();
          _resumeBytes = b;
        });
      }
    }
  }

  @override
  void dispose() {
    if (_running) widget.downloader.cancel();
    super.dispose();
  }

  String _mb(num b) => (b / 1e6).toStringAsFixed(b < 10e6 ? 1 : 0);

  @override
  Widget build(BuildContext context) {
    final s = widget.spec;
    final p = _p;
    final eta = p != null && p.bytesPerSecond > 0 ? Duration(seconds: ((p.total - p.done) / p.bytesPerSecond).round()) : null;
    final resume = !_running && _resumeBytes > 0 && _resumeBytes < s.totalBytes;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: ListView(
              padding: const EdgeInsets.all(24),
              shrinkWrap: true,
              children: [
                const Text('OPENATC', style: TextStyle(letterSpacing: 3, fontWeight: FontWeight.w700, color: AtcColors.accent)),
                const SizedBox(height: 12),
                const Text('Talk to your traffic', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                const Text(
                  'Push-to-talk runs speech recognition on this phone. The model downloads once; your voice never leaves the device.',
                  style: TextStyle(color: AtcColors.muted, height: 1.4),
                ),
                const SizedBox(height: 20),
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: AtcColors.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: AtcColors.line)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(s.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 6),
                    Text('${_mb(s.totalBytes)} MB · ${s.files.length} files · version ${s.version} · ${s.license}', style: const TextStyle(color: AtcColors.muted, fontSize: 13)),
                    Text(s.hotwords ? 'Streaming, with callsign hotwords' : 'Transcribes on release', style: const TextStyle(color: AtcColors.muted, fontSize: 13)),
                    const SizedBox(height: 14),
                    if (_running || p != null) ...[
                      ClipRRect(
                        borderRadius: BorderRadius.circular(4),
                        child: LinearProgressIndicator(value: p?.fraction, minHeight: 8, backgroundColor: AtcColors.raise, color: AtcColors.accent),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        p == null
                            ? 'Connecting…'
                            : '${_mb(p.done)} / ${_mb(p.total)} MB · ${(p.fraction * 100).toStringAsFixed(0)}%'
                                '${p.bytesPerSecond > 0 ? ' · ${(p.bytesPerSecond / 1e6).toStringAsFixed(1)} MB/s' : ''}'
                                '${eta != null ? ' · ${eta.inMinutes}:${(eta.inSeconds % 60).toString().padLeft(2, '0')} left' : ''}',
                        style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()], fontSize: 13),
                      ),
                      if (p != null) Text('File ${p.fileIndex + 1} of ${p.fileCount}: ${p.file}', style: const TextStyle(color: AtcColors.muted, fontSize: 12)),
                    ],
                    if (_error != null) ...[
                      const SizedBox(height: 10),
                      Text(_error!, style: const TextStyle(color: AtcColors.bad, fontSize: 13)),
                    ],
                  ]),
                ),
                const SizedBox(height: 20),
                Row(children: [
                  Expanded(
                    child: FilledButton(
                      onPressed: _running ? () => widget.downloader.cancel() : _go,
                      style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
                      child: Text(_running ? 'Pause' : resume ? 'Resume (${(_resumeBytes / s.totalBytes * 100).toStringAsFixed(0)}% done)' : 'Download ${_mb(s.totalBytes)} MB'),
                    ),
                  ),
                ]),
                const SizedBox(height: 8),
                TextButton(onPressed: _running ? null : widget.onSkip, child: const Text('Skip: play with typed commands')),
                const SizedBox(height: 8),
                Text('Source: ${s.source}', style: const TextStyle(color: AtcColors.muted, fontSize: 11)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
