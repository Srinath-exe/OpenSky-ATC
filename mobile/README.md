# OpenATC phone app

A Flutter shell around the live web game, adding what a phone does better than a page: the microphone and
on-device speech-to-text. The game itself (rules parser, S1 model, simulation) stays in the WebView, so there is one
code path for understanding commands on every platform.

```
Flutter app
 ├─ ModelScreen   first run: download the pinned speech model (progress, resume, SHA-256), then
 └─ GameScreen    WebView → https://openatc.aeon-labs.site/
       page  ──OpenATCNative.postMessage({type:'start', id, hotwords})──▶  app: mic (record) → isolate: sherpa-onnx
       page  ◀──CustomEvent 'openatc-native' {type:'partial'|'final', text, ms}──  app
       page: rules parser → S1 model → command (unchanged web code, recogniser = 'native')
```

Report with diagrams, the runtime choices and measured numbers: https://openatc.aeon-labs.site/reports/mobile-app.html

## Layout

| Path | What |
|---|---|
| `lib/main.dart` | start-up: model installed → game, else the download screen |
| `lib/src/models/manifest.dart` | the model manifest (id, version, kind, files with url / sha256 / size) |
| `lib/src/models/downloader.dart` | download with HTTP Range resume, SHA-256 check, `.installed.json`, old versions pruned |
| `lib/src/stt/stt_engine.dart` | sherpa-onnx wrapper: streaming transducer (+ hotwords) or offline Moonshine; pure Dart + FFI |
| `lib/src/stt/stt_service.dart` | runs the engine in a background isolate |
| `lib/src/stt/hotwords.dart` | game hints ("speedbird 273", "runway 27R") → hotword lines ("SPEEDBIRD TWO SEVEN THREE :2.0") |
| `lib/src/stt/bpe_vocab.dart` | SentencePiece `bpe.model` → `bpe.vocab` on device (what sherpa-onnx needs for hotwords) |
| `lib/src/bridge/protocol.dart` | the JS bridge messages (mirrors `src/lib/voice/recognizer.ts` `createNativeRecognizer`) |
| `lib/src/bridge/voice_bridge.dart` | page message → mic → STT → events back to the page |
| `lib/src/audio/mic.dart` | 16 kHz PCM16 mic stream, kept warm 20 s with a 200 ms pre-roll |
| `assets/stt_models.json` | the pinned manifest (the active model + alternatives) |
| `tool/stt_bench.dart` | runs the same engine on the bake-off clips on Linux (`ml/gpu/results/stt`) |
| `tool/bench_models.json` | candidates benchmarked for the pick (incl. Moonshine, which is not an app download) |

## Toolchain (on the VPS)

Everything lives under `/opt` (Flutter 3.47.9, Temurin JDK 17, Android SDK platform 36 + build-tools 36 + NDK 28.2):

```bash
source /opt/mobile-env.sh          # JAVA_HOME, ANDROID_HOME, PUB_CACHE, GRADLE_USER_HOME, PATH
cd mobile
flutter pub get
flutter analyze
flutter test                        # manifest, downloader (local HTTP server), bridge, hotwords, bpe.vocab
```

## Build

```bash
flutter build apk --release --target-platform android-arm64 --dart-define=APP_VERSION=1.0.0
cp build/app/outputs/flutter-apk/app-release.apk ../public/downloads/openatc-1.0.0.apk
(cd android && ./gradlew --stop)   # free the Gradle daemon's RAM on the shared host
```

- Release builds are signed with the debug key so the APK side-loads; a store release needs a real upload key.
  The key is this host's `/root/.android/debug.keystore`: an APK built elsewhere has another key and Android refuses to
  install it over this one (uninstall first).
- Only `arm64-v8a` is packaged (sherpa-onnx ships four ABIs, 94 MB → 44 MB): `android/gradle.properties` sets
  `disable-abi-filtering=true` so Flutter's plugin keeps `app/build.gradle.kts`'s filter; `-Pall-abis=true` keeps them all.
- The first build on the VPS took ~40 min (Gradle + Kotlin under a load average of 20); incremental builds take ~30 s.
- `--dart-define=GAME_URL=https://...` points the WebView at another deployment (e.g. a staging box).
- `--dart-define=LAYOUT_WIDTH=0` stops the app from laying the page out at 1280 CSS px.
- iOS: the project is configured (microphone usage string, iOS 15) but needs a Mac: `flutter build ios`.

## Run on a phone

```bash
adb install -r ../public/downloads/openatc-1.0.0.apk
adb logcat | grep -i -E 'flutter|sherpa'
```

Or open https://openatc.aeon-labs.site/downloads/openatc-1.0.0.apk on the phone and allow the install.

## Update the speech model

1. Pick the files (Hugging Face, pinned to a commit: `https://huggingface.co/<repo>/resolve/<40-hex commit>/<file>`).
2. Download them once and hash them: `sha256sum *.onnx tokens.txt bpe.model; stat -c %s ...`.
3. Add an entry to `assets/stt_models.json` with a new `version` (or a new `id`), set `active` to it. Roles:
   transducer = `encoder`, `decoder`, `joiner`, `tokens` (+ `bpe_model` when `"hotwords": true`);
   moonshine = `encoder`, `merged_decoder`, `tokens`.
4. Benchmark it first: `dart run tool/stt_bench.dart --manifest assets/stt_models.json --model <id> --dir <local dir> --out /tmp/b`,
   then `cp ../ml/gpu/results/stt/clips.json /tmp/b && ../ml/.venv/bin/python ../ml/stt/score.py --dir /tmp/b` for WER and
   command accuracy.
5. Ship the app. On start it sees the new version is not installed, downloads it, verifies every file, writes
   `.installed.json` and deletes the previous version's directory.

`flutter test test/manifest_test.dart` checks that every entry is well-formed and pinned to a commit.

## The bridge

Page → app (`window.OpenATCNative.postMessage(JSON)`): `hello` · `start {id, hotwords, callsigns}` · `stop {id}` · `cancel {id}`.
App → page (`window.dispatchEvent(new CustomEvent('openatc-native', {detail}))`):
`hello {state, model, hotwords, streaming}` · `started` · `partial {text}` · `final {text, ms, computeMs, audioMs, rtf, model}` ·
`error {code: mic-denied | no-model | busy | stt | bad-message, message}`.
`ms` is PTT release → final text measured on the phone; the chip in the top-right corner of the game shows it with the
real-time factor (compute time / audio time). The channel is only registered when a model is installed, so without
one the page behaves exactly like a browser.
