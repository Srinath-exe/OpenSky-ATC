"""Fine-tune Moonshine base (UsefulSensors/moonshine-base, MIT, 61 M) on the ATC speech data: the on-device model for the
browser (transformers.js, public/voice/stt-worker.js) and the phone. Same manifests and labels as the server model
(ml/stt/train_parakeet.py, ml/stt/DATA.md).

    python ml/stt/train_moonshine.py train  --out W [--train manifests/train_all.jsonl] [--epochs 4] [--smoke]
    python ml/stt/train_moonshine.py export --model W/best --out W/web     # the onnx-community/moonshine-base-ONNX layout
    python ml/stt/train_moonshine.py eval   --model W/best --out W         # WER per test list, base vs tuned (numbers folded)

export writes config/tokenizer/preprocessor files and onnx/{encoder_model,decoder_model_merged}{,_quantized}.onnx: what
transformers.js loads for dtype q8 (the game's default) or fp32. Manifest audio paths are moved under --root like
train_parakeet.py does."""
import argparse, json, math, os, random, sys, time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/stt/data"))
BASE = "UsefulSensors/moonshine-base"
EOS = 2   # </s> (config.eos_token_id; also its pad_token_id)


def rows(manifest, root, limit=None, maxdur=15.0):
    out = []
    for l in open(manifest):
        r = json.loads(l)
        if not r.get("text") or r["duration"] > maxdur or r["duration"] < 0.3: continue
        p = r["audio_filepath"].replace("/root/atc", root, 1) if root else r["audio_filepath"]
        out.append((p, r["text"], r["duration"]))
        if limit and len(out) >= limit: break
    return out


def load(p):
    x, sr = sf.read(p, dtype="float32")
    if x.ndim > 1: x = x.mean(axis=1)
    assert sr == 16000, p
    return x


class Batches:
    """Length-bucketed batches of at most `seconds` of audio (short clips, big batches; long clips, small ones)."""
    def __init__(self, data, seconds, shuffle, seed=0):
        self.data, self.seconds, self.shuffle, self.rnd = data, seconds, shuffle, random.Random(seed)

    def __iter__(self):
        idx = sorted(range(len(self.data)), key=lambda i: self.data[i][2] + (self.rnd.random() * 0.5 if self.shuffle else 0))
        batches, cur, tot = [], [], 0.0
        for i in idx:
            d = self.data[i][2]
            if cur and (tot + d > self.seconds or len(cur) >= 64): batches.append(cur); cur, tot = [], 0.0
            cur.append(i); tot += d
        if cur: batches.append(cur)
        if self.shuffle: self.rnd.shuffle(batches)
        return iter(batches)


def collate(proc, tok, data, ids, device):
    audio = [load(data[i][0]) for i in ids]
    feats = proc(audio, sampling_rate=16000, return_tensors="pt", padding=True, return_attention_mask=True)
    # labels = text tokens + </s> (id 2), padded with -100; the model shifts them right after <s> (decoder_start 1).
    # The tokenizer has no special tokens of its own: the ids live in the model config.
    seqs = [tok(data[i][1], add_special_tokens=False).input_ids + [EOS] for i in ids]
    labels = torch.full((len(seqs), max(map(len, seqs))), -100, dtype=torch.long)
    for j, q in enumerate(seqs): labels[j, :len(q)] = torch.tensor(q)
    return {k: v.to(device) for k, v in {"input_values": feats.input_values, "attention_mask": feats.attention_mask, "labels": labels}.items()}


@torch.no_grad()
def transcribe(model, proc, tok, paths, device, bs=16):
    model.eval(); out = []
    for i in range(0, len(paths), bs):
        audio = [load(p) for p in paths[i:i + bs]]
        f = proc(audio, sampling_rate=16000, return_tensors="pt", padding=True, return_attention_mask=True)
        # Moonshine: about 6.5 tokens per second of audio is the documented cap
        mx = int(max(len(a) for a in audio) / 16000 * 6.5) + 8
        g = model.generate(input_values=f.input_values.to(device), attention_mask=f.attention_mask.to(device), max_new_tokens=mx)
        out += tok.batch_decode(g, skip_special_tokens=True)
    return [o.strip() for o in out]


def cmd_train(a):
    from transformers import AutoProcessor, MoonshineForConditionalGeneration
    from wer import wer_num
    w = Path(a.out); w.mkdir(parents=True, exist_ok=True)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    proc = AutoProcessor.from_pretrained(BASE); tok = proc.tokenizer
    model = MoonshineForConditionalGeneration.from_pretrained(a.init or BASE).to(dev)
    train = rows(a.train, a.root, 48 if a.smoke else None)
    val = [r for v in a.val for r in rows(v, a.root, 12 if a.smoke else 250)]
    sec = 40.0 if a.smoke else a.batch_seconds
    steps_per_epoch = sum(1 for _ in Batches(train, sec, True))
    total = 3 if a.smoke else steps_per_epoch * a.epochs // a.accum
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01, betas=(0.9, 0.98))
    warm = 2 if a.smoke else min(500, total // 10)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * max(0.05, 0.5 * (1 + math.cos(math.pi * min(1.0, s / max(1, total))))))
    amp = torch.autocast("cuda", dtype=torch.bfloat16) if dev == "cuda" else torch.autocast("cpu", enabled=False)

    def evaluate():
        hyp = transcribe(model, proc, tok, [p for p, _, _ in val], dev)
        e = sum(wer_num(t, h) * len(t.split()) for (_, t, _), h in zip(val, hyp)); n = sum(len(t.split()) for _, t, _ in val)
        model.train(); return e / max(1, n), hyp

    base_wer, _ = evaluate(); best = base_wer
    print(f"train {len(train)} clips, {steps_per_epoch} batches/epoch, {total} updates; val {len(val)} clips, base WER {base_wer:.4f}", flush=True)
    model.train(); step = 0; t0 = time.time(); every = 2 if a.smoke else max(200, total // 12)
    for ep in range(a.epochs):
        for k, ids in enumerate(Batches(train, sec, True, seed=ep)):
            with amp: loss = model(**collate(proc, tok, train, ids, dev)).loss / a.accum
            loss.backward()
            if (k + 1) % a.accum: continue
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step(); sched.step(); opt.zero_grad(); step += 1
            if step % 50 == 0 or a.smoke: print(f"epoch {ep} step {step}/{total} loss {loss.item() * a.accum:.3f} lr {sched.get_last_lr()[0]:.2e} {(time.time() - t0) / 60:.1f} min", flush=True)
            if step % every == 0 or step == total:
                v, hyp = evaluate(); print(f"step {step} val_wer {v:.4f} (best {best:.4f}) e.g. {hyp[0]!r}", flush=True)
                if v < best: best = v; model.save_pretrained(w / "best"); proc.save_pretrained(w / "best")
            if step >= total: break
        if step >= total: break
    if not (w / "best").exists(): model.save_pretrained(w / "best"); proc.save_pretrained(w / "best")
    print(f"trained in {(time.time() - t0) / 60:.1f} min; val WER base {base_wer:.4f} -> best {best:.4f}", flush=True)


def cmd_export(a):
    """optimum's ONNX export (encoder, decoder, decoder with past, merged), then dynamic int8 as *_quantized.onnx."""
    import shutil, subprocess
    from onnxruntime.quantization import QuantType, quantize_dynamic
    out = Path(a.out); onnx = out / "onnx"; onnx.mkdir(parents=True, exist_ok=True)
    tmp = out / "_optimum"
    # the toolchain onnx-community used for moonshine-base-ONNX: optimum 1.25 + transformers 4.51 + torch 2.5
    # (ml/stt/venvs/hfexport). Its graphs take no attention masks, as transformers.js expects; today's optimum-onnx
    # adds mask inputs and its decoder breaks on clips over ~8 s (a cross-attention mask baked at a traced size).
    py = os.environ.get("MOONSHINE_EXPORT_PY", str(ROOT / "ml/stt/venvs/hfexport/bin/python"))
    src = out / "_src"; shutil.rmtree(src, ignore_errors=True); shutil.copytree(a.model, src)
    cfg = json.load(open(src / "config.json"))   # 4.51 reads these keys; newer versions dropped them
    for k in ("num_attention_heads", "num_hidden_layers", "num_key_value_heads"): cfg.setdefault(k, cfg[f"decoder_{k}"])
    cfg["max_position_embeddings"] = max(cfg.get("max_position_embeddings", 0), 512)
    json.dump(cfg, open(src / "config.json", "w"), indent=2)
    subprocess.run([py, "-m", "optimum.exporters.onnx", "--model", str(src), "--task", "automatic-speech-recognition-with-past", str(tmp)], check=True)
    shutil.rmtree(src, ignore_errors=True)
    for f in tmp.iterdir():
        if f.suffix == ".onnx" or f.name.endswith(".onnx_data"): shutil.move(str(f), onnx / f.name)
        elif f.is_file(): shutil.copy(f, out / f.name)
    shutil.rmtree(tmp, ignore_errors=True)
    # int8: encoder and the two decoders; the merged decoder (an If over both) is rebuilt from the quantized pair,
    # because dynamic quantisation does not reach inside the If's subgraphs (it stayed fp32, 167 MB)
    for name in ("encoder_model", "decoder_model", "decoder_with_past_model"):
        src = onnx / f"{name}.onnx"
        # MatMul only: int8 convolutions on the raw waveform (the encoder's first layers) made it emit nothing on
        # some clips; the matrix products are most of the weights anyway (encoder 81 -> 31 MB, decoder 166 -> 43 MB)
        if src.exists(): quantize_dynamic(str(src), str(onnx / f"{name}_quantized.onnx"), weight_type=QuantType.QUInt8, op_types_to_quantize=["MatMul"])
    # the files transformers.js reads, as in onnx-community/moonshine-base-ONNX: its Moonshine feature extractor, and
    # the attention shape keys it sizes the cache from
    json.dump({"feature_extractor_type": "MoonshineFeatureExtractor", "processor_class": "MoonshineProcessor", "sampling_rate": 16000},
              open(out / "preprocessor_config.json", "w"), indent=2)
    cfg = json.load(open(out / "config.json"))
    for k in ("num_attention_heads", "num_hidden_layers", "num_key_value_heads"): cfg.setdefault(k, cfg[f"decoder_{k}"])
    json.dump(cfg, open(out / "config.json", "w"), indent=2)
    from optimum.onnx import merge_decoders
    merge_decoders(str(onnx / "decoder_model_quantized.onnx"), str(onnx / "decoder_with_past_model_quantized.onnx"),
                   save_path=str(onnx / "decoder_model_merged_quantized.onnx"), strict=False)
    for f in onnx.glob("*.onnx"): drop_mask_inputs(f)   # a no-op with the 1.25 toolchain (kept for newer exports)
    print(sorted((p.relative_to(out).as_posix(), p.stat().st_size) for p in out.rglob("*") if p.is_file()))


def drop_mask_inputs(path):
    """transformers.js feeds Moonshine's encoder input_values only and the decoder no encoder mask (the stock
    onnx-community graphs have no mask inputs); optimum's graphs ask for them. One unpadded clip at a time, so the
    masks are all ones: build them inside the graph from the shape of the tensor they belong to."""
    import onnx
    from onnx import helper, TensorProto, numpy_helper
    m = onnx.load(str(path)); g = m.graph; names = [i.name for i in g.input]
    pairs = [("attention_mask", "input_values"), ("encoder_attention_mask", "encoder_hidden_states")]
    nodes = []
    for mask, ref in pairs:
        if mask not in names or ref not in names: continue
        dt = next(i for i in g.input if i.name == mask).type.tensor_type.elem_type
        k = mask + "_built"
        c = lambda n, v: g.initializer.append(numpy_helper.from_array(np.array(v, np.int64), k + n))
        c("_0", [0]); c("_1", [1]); c("_2", [2]); c("_3", [3])
        nodes += [helper.make_node("Shape", [ref], [k + "_shape"]),
                  helper.make_node("Slice", [k + "_shape", k + "_0", k + "_1"], [k + "_b"]),
                  helper.make_node("Slice", [k + "_shape", k + "_1", k + "_2"], [k + "_t"])]
        t = k + "_t"
        past = "past_key_values.0.encoder.key"
        if mask == "encoder_attention_mask" and past in names:
            # cached steps: transformers.js passes a stand-in encoder_hidden_states; the cached cross-attention keys
            # [batch, heads, T_enc, dim] carry the real length (and are empty on the first step)
            nodes += [helper.make_node("Shape", [past], [k + "_pshape"]),
                      helper.make_node("Slice", [k + "_pshape", k + "_2", k + "_3"], [k + "_pt"]),
                      helper.make_node("Max", [k + "_t", k + "_pt"], [k + "_tm"])]
            t = k + "_tm"
        nodes += [helper.make_node("Concat", [k + "_b", t], [k + "_bt"], axis=0),
                  helper.make_node("ConstantOfShape", [k + "_bt"], [mask], value=helper.make_tensor(k + "_one", dt, [1], [1]))]
        g.input.remove(next(i for i in g.input if i.name == mask))
    if nodes:
        for n in reversed(nodes): g.node.insert(0, n)
        onnx.save(m, str(path)); print("masks built inside", path.name)


def cmd_eval(a):
    from transformers import AutoProcessor, MoonshineForConditionalGeneration
    from wer import wer_num
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    proc = AutoProcessor.from_pretrained(BASE); tok = proc.tokenizer; res = {}; w = Path(a.out)
    for tag, src in (("base", BASE), ("tuned", a.model)):
        model = MoonshineForConditionalGeneration.from_pretrained(src).to(dev)
        for t in a.tests:
            data = rows(t, a.root, maxdur=60)
            hyp = transcribe(model, proc, tok, [p for p, _, _ in data], dev)
            e = sum(wer_num(x, h) * len(x.split()) for (_, x, _), h in zip(data, hyp)); n = sum(len(x.split()) for _, x, _ in data)
            res.setdefault(Path(t).stem, {})[tag] = round(e / max(1, n), 4)
            with open(w / f"moon_hyp_{tag}_{Path(t).stem}.jsonl", "w") as fo:
                for (_, x, _), h in zip(data, hyp): fo.write(json.dumps({"ref": x, "hyp": h}) + "\n")
            print(tag, Path(t).stem, res[Path(t).stem][tag], flush=True)
    json.dump(res, open(w / "moon_eval.json", "w"), indent=1); print(json.dumps(res, indent=1))


def main():
    M = ROOT / "ml/data/stt/manifests"
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["train", "export", "eval"])
    ap.add_argument("--out", required=True); ap.add_argument("--model"); ap.add_argument("--init", default=""); ap.add_argument("--root", default="")
    ap.add_argument("--train", default=str(M / "train_all.jsonl"))
    ap.add_argument("--val", nargs="+", default=[str(M / f"{n}.jsonl") for n in ("test_cov", "test_uwb")])
    ap.add_argument("--tests", nargs="+", default=[str(M / f"test_{n}.jsonl") for n in ("cov", "synth", "atco2", "uwb", "atcosim")])
    ap.add_argument("--epochs", type=int, default=4); ap.add_argument("--batch-seconds", type=float, default=320.0); ap.add_argument("--accum", type=int, default=1)
    ap.add_argument("--lr", type=float, default=1e-4); ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args(); {"train": cmd_train, "export": cmd_export, "eval": cmd_eval}[a.cmd](a)


if __name__ == "__main__":
    main()
