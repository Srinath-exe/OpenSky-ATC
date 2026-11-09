# Phone speech-to-text: switch the active model to Moonshine base (sherpa-onnx)

Measured 2026-11-09 (ml/stt/models/EDGE.md, `/reports/voice-stt-models.html`) with `tool/stt_bench.dart`, the app's own
`SttEngine` and hotword builder, on the bench2 clips, scored by the game's chain (n-best + repair + S1 `2m-grpo-v1`):

| active model | exact US/UK (n=320) | exact Indian proxy (n=160) | sent wrong | download |
|---|--:|--:|--:|--:|
| `zipformer-en-2023-06-26-int8` + hotwords (today) | 57.8% | 57.5% | 4.7% / 5.6% | 73 MB |
| Moonshine base, sherpa-onnx `.ort` quantized 2026-02-27 | **67.8%** | **76.9%** | 5.9% / 1.9% | 141 MB |

No runtime change: `SttEngine` already has the `moonshine` kind (`OfflineMoonshineModelConfig`, encoder + merged
decoder). It is offline, so all of the work happens after release (0.47-0.54 s median on 2 x86 threads here; expect
about 0.5-1 s on a mid-range phone). There are no hotwords for Moonshine in sherpa-onnx; the game's repair and S1 do the
callsign matching, which is why it still wins.

## The change (not built)

`assets/stt_models.json`: add this entry and set `"active": "moonshine-base-en-quantized-2026-02-27"` (keep the zipformer
entry so a player on a small phone can go back).

The encoder and decoder are byte-identical (sha256) to `moonshine-ai/moonshine-voice-assets`, which serves them one file
at a time; `tokens.txt` is only inside the sherpa-onnx tar.bz2, so it has to be hosted by us (550 KB, e.g.
`https://openatc.aeon-labs.site/models/stt/moonshine-base-en-2026-02-27/tokens.txt`, from
`sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`).

```json
{
 "id": "moonshine-base-en-quantized-2026-02-27",
 "name": "Moonshine base (English), quantized",
 "version": "2026.02.27",
 "kind": "moonshine",
 "license": "MIT",
 "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2",
 "sampleRate": 16000,
 "hotwords": false,
 "notes": "offline (transcribes on release); +10 pts US/UK, +19 pts Indian proxy over the zipformer (ml/stt/models/EDGE.md)",
 "files": [
  {"role": "encoder", "name": "encoder_model.ort",
   "url": "https://huggingface.co/moonshine-ai/moonshine-voice-assets/resolve/015f7269048251aff164cb60df02bfea76884c8f/model/base-en/quantized/base-en/encoder_model.ort",
   "sha256": "7c66495948d0d08ec1af454cd4b5514862ae6511e94712a60e6d83eaec8dc8cf", "size": 31326816},
  {"role": "merged_decoder", "name": "decoder_model_merged.ort",
   "url": "https://huggingface.co/moonshine-ai/moonshine-voice-assets/resolve/015f7269048251aff164cb60df02bfea76884c8f/model/base-en/quantized/base-en/decoder_model_merged.ort",
   "sha256": "d9d7b333af34bc552580576ddcf248a1c6c839e0d3b43b09afb9376ed009899d", "size": 109424400},
  {"role": "tokens", "name": "tokens.txt",
   "url": "https://openatc.aeon-labs.site/models/stt/moonshine-base-en-2026-02-27/tokens.txt",
   "sha256": "2870d843e14c1e187bf1913a521562a63b53933814bd7f2145120468f494a049", "size": 549350}
 ]
}
```

Check on a phone before release: RAM (the decoder is 109 MB; expect ~300-400 MB resident), and the time after release
on a low-end device. Settings label: "Phone (Moonshine, 141 MB)".

## Alternatives measured

- Parakeet TDT 110M int8 + hotwords, sherpa-onnx offline transducer (136 MB, CC-BY-4.0: attribution needed):
  69.4% / 68.8%. Better on US/UK, 8 points worse on the Indian proxy.
- Moonshine v2 small streaming with keyterms (moonshine-voice Android SDK, 142 MB, MIT): 70.9% / 74.4%; a new runtime.
- Whistle (Cactus, `android-arm64/libcactus.a` + 16.9 MB weights, Apache-2.0): 64.4% / 66.9%; the lightest by far.
- Phonon-2.5 English on LiteRT (int8 CPU build 0.94 GB; 6.1 GB peak RAM on a Galaxy S26 per its card): 72.8% / 76.9%.
