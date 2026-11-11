"""Fine-tune the game's speech-to-text model (Parakeet Ultra = nvidia/parakeet-tdt-0.6b-v3 architecture with
moondream/parakeet-ultra weights, what sherpa-onnx's parakeet-tdt-0.6b-ultra build exports) on ATC speech.

    python ml/stt/train_parakeet.py base   --out W                 # v3 .nemo + Ultra weights -> W/ultra.nemo
    python ml/stt/train_parakeet.py train  --out W --train ml/data/stt/manifests/train_all.jsonl [--epochs 3] [--smoke]
    python ml/stt/train_parakeet.py export --nemo W/atc.nemo --out W/onnx   # encoder/decoder/joiner .int8.onnx, tokens.txt, bpe.vocab
    python ml/stt/train_parakeet.py eval   --nemo W/atc.nemo --out W        # WER per test list (numbers folded), base vs tuned

Data: ml/stt/DATA.md (manifests from ml/stt/data/build_manifests.py; audio paths are rewritten with --root when the
data lives elsewhere, e.g. on the GPU box). Labels are lower-case spoken words ("speedbird three two seven climb flight
level eight zero"); the game's cleanup (src/lib/voice/asr-repair.ts) reads words and digits alike.
`export` and `base` reuse sherpa-onnx's scripts/nemo/parakeet-tdt-0.6b-ultra/export_onnx.py (fetched to W/sherpa/)."""
import argparse, json, os, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml/stt/data"))
SHERPA = "https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/scripts/nemo/"


def sherpa_scripts(w: Path):
    d = w / "sherpa"; (d / "parakeet-tdt-0.6b-ultra").mkdir(parents=True, exist_ok=True)
    for rel in ("parakeet-tdt-0.6b-ultra/export_onnx.py", "generate_bpe_vocab.py"):
        if not (d / rel).exists(): urllib.request.urlretrieve(SHERPA + rel, d / rel)
    sys.path.insert(0, str(d)); sys.path.insert(0, str(d / "parakeet-tdt-0.6b-ultra"))
    import export_onnx
    return export_onnx


def rewrite(manifest: str, root: str, w: Path, limit=None) -> str:
    """Manifest with audio paths moved under --root (paths are absolute on the VPS)."""
    out = w / ("m_" + Path(manifest).name); n = 0
    with open(out, "w") as fo:
        for l in open(manifest):
            r = json.loads(l)
            if root: r["audio_filepath"] = r["audio_filepath"].replace("/root/atc", root, 1)
            if not r.get("text"): continue
            fo.write(json.dumps({k: r[k] for k in ("audio_filepath", "duration", "text")}) + "\n"); n += 1
            if limit and n >= limit: break
    return str(out)


def cmd_base(a):
    w = Path(a.out); w.mkdir(parents=True, exist_ok=True)
    E = sherpa_scripts(w)
    import nemo.collections.asr as nemo_asr
    from safetensors.torch import load_file
    os.chdir(w)
    nemo_path = E.local_or_download("./parakeet-tdt-0.6b-v3.nemo", E.V3, "parakeet-tdt-0.6b-v3.nemo")
    weights = E.local_or_download("./model.safetensors", E.ULTRA, "model.safetensors")
    tok = E.local_or_download("./tokenizer.json", E.ULTRA, "tokenizer.json")
    m = nemo_asr.models.ASRModel.restore_from(restore_path=str(nemo_path))
    E.check_vocabulary(m, tok)
    res = m.load_state_dict(E.ultra_state_for(m, load_file(str(weights))), strict=False)
    if res.unexpected_keys or any(not E.KEPT.fullmatch(k) for k in res.missing_keys): raise SystemExit(f"load_state_dict: {res}")
    m.save_to(str(w / "ultra.nemo")); print("saved", w / "ultra.nemo")


def cmd_train(a):
    import torch, lightning.pytorch as pl
    from omegaconf import open_dict
    import nemo.collections.asr as nemo_asr
    from lightning.pytorch.callbacks import ModelCheckpoint
    w = Path(a.out); w.mkdir(parents=True, exist_ok=True)
    m = nemo_asr.models.ASRModel.restore_from(a.init or str(w / "ultra.nemo"), map_location="cpu")   # --init: continue from an earlier fine-tune
    lim = 64 if a.smoke else None
    train = rewrite(a.train, a.root, w, lim)
    val = str(w / "m_val.jsonl")   # one validation list, so NeMo logs a single "val_wer" for the checkpoint callback
    with open(val, "w") as fo:
        for v in a.val: fo.write(open(rewrite(v, a.root, w, 300 if not a.smoke else 16)).read())
    with open_dict(m.cfg):
        for key, man, shuffle in (("train_ds", train, True), ("validation_ds", val, False)):
            ds = m.cfg[key]
            for k in list(ds.keys()):
                if k.startswith(("tarred", "is_tarred", "use_lhotse", "batch_duration", "bucket", "shar", "lhotse", "use_bucketing", "num_buckets", "quadratic", "max_tps", "shuffle_buffer")): ds.pop(k)
            ds.manifest_filepath = man; ds.shuffle = shuffle; ds.batch_size = a.batch if key == "train_ds" else 16
            ds.max_duration = a.maxdur; ds.min_duration = 0.3; ds.num_workers = 0 if a.smoke else a.workers; ds.pin_memory = False
            ds.is_tarred = False; ds.use_lhotse = False
        m.cfg.optim.lr = a.lr
        m.cfg.optim.sched = {"name": "CosineAnnealing", "warmup_steps": 2 if a.smoke else 400, "min_lr": a.lr / 20}
    m.setup_training_data(m.cfg.train_ds); m.setup_multiple_validation_data(m.cfg.validation_ds); m.setup_optimization(m.cfg.optim)
    gpu = torch.cuda.is_available()
    ckpt = ModelCheckpoint(dirpath=w / "ckpt", monitor="val_wer", mode="min", save_top_k=1, filename="best-{epoch}-{val_wer:.4f}")
    trainer = pl.Trainer(accelerator="gpu" if gpu else "cpu", devices=1, precision="bf16-mixed" if gpu else "32-true",
                         max_epochs=a.epochs, max_steps=4 if a.smoke else -1, accumulate_grad_batches=a.accum,
                         gradient_clip_val=1.0, log_every_n_steps=10, val_check_interval=0.5 if not a.smoke else 1.0,
                         limit_val_batches=2 if a.smoke else 1.0, callbacks=[ckpt], logger=False, enable_checkpointing=True,
                         default_root_dir=str(w))
    m.set_trainer(trainer)
    t0 = time.time(); trainer.fit(m); print(f"trained in {(time.time() - t0) / 60:.1f} min; best {ckpt.best_model_path} {ckpt.best_model_score}")
    if ckpt.best_model_path and not a.smoke:
        sd = torch.load(ckpt.best_model_path, map_location="cpu", weights_only=False)["state_dict"]; m.load_state_dict(sd)
    m.save_to(str(w / ("smoke.nemo" if a.smoke else "atc.nemo"))); print("saved", w / ("smoke.nemo" if a.smoke else "atc.nemo"))


def cmd_export(a):
    """sherpa-onnx's recipe (scripts/nemo/parakeet-tdt-0.6b-ultra/export_onnx.py main), on our .nemo: tokens.txt, bpe.vocab
    (hotwords), encoder/decoder/joiner ONNX, int8 dynamic quantisation, the encoder's metadata ("tdt" in url: sherpa-onnx
    decodes it as a TDT model, like today's)."""
    import torch
    import nemo.collections.asr as nemo_asr
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    E = sherpa_scripts(out.parent)
    from generate_bpe_vocab import generate_bpe_vocab_from_model
    from onnxruntime.quantization import QuantType, quantize_dynamic
    m = nemo_asr.models.ASRModel.restore_from(str(Path(a.nemo).resolve()), map_location="cpu").eval()
    os.chdir(out)
    with open("tokens.txt", "w", encoding="utf-8") as f:
        for i, s in enumerate(m.joint.vocabulary): f.write(f"{s} {i}\n")
        f.write(f"<blk> {i + 1}\n")
    generate_bpe_vocab_from_model(asr_model=m, output_path="./bpe.vocab")
    with torch.no_grad():
        m.encoder.export("encoder.onnx"); m.decoder.export("decoder.onnx"); m.joint.export("joiner.onnx")
    norm_type = m.cfg.preprocessor.normalize
    meta = {"vocab_size": m.decoder.vocab_size, "normalize_type": "" if norm_type == "NA" else norm_type,
            "pred_rnn_layers": m.decoder.pred_rnn_layers, "pred_hidden": m.decoder.pred_hidden, "subsampling_factor": 8,
            "model_type": "EncDecRNNTBPEModel", "version": "2", "model_author": "OpenATC",
            "url": "OpenATC ATC fine-tune of moondream/parakeet-ultra (tdt, nvidia/parakeet-tdt-0.6b-v3 architecture)",
            "comment": "Only the transducer branch is exported", "feat_dim": 128}
    for part in ("encoder", "decoder", "joiner"):
        quantize_dynamic(model_input=f"./{part}.onnx", model_output=f"./{part}.int8.onnx",
                         weight_type=QuantType.QUInt8 if part == "encoder" else QuantType.QInt8)
    E.add_meta_data("encoder.int8.onnx", meta)
    for f in Path(".").glob("*.onnx"):
        if not f.name.endswith(".int8.onnx"): f.unlink()
    for f in ("encoder.weights",): Path(f).unlink(missing_ok=True)
    print(sorted((p.name, p.stat().st_size) for p in Path(".").iterdir()))


def cmd_eval(a):
    import nemo.collections.asr as nemo_asr
    from wer import wer_num, norm
    w = Path(a.out); res = {}
    for tag, path in (("base", Path(a.base) if a.base else w / "ultra.nemo"), ("tuned", Path(a.nemo))):
        if not path.exists(): continue
        m = nemo_asr.models.ASRModel.restore_from(str(path)).eval()
        for t in a.tests:
            rows = [json.loads(l) for l in open(rewrite(t, a.root, w))]
            hyps = m.transcribe([r["audio_filepath"] for r in rows], batch_size=32)
            hyps = [h.text if hasattr(h, "text") else str(h) for h in (hyps[0] if isinstance(hyps, tuple) else hyps)]
            errs = sum(wer_num(r["text"], h) * len(r["text"].split()) for r, h in zip(rows, hyps)); words = sum(len(r["text"].split()) for r in rows)
            res.setdefault(Path(t).stem, {})[tag] = round(errs / max(1, words), 4)
            with open(w / f"hyp_{tag}_{Path(t).stem}.jsonl", "w") as fo:
                for r, h in zip(rows, hyps): fo.write(json.dumps({"ref": r["text"], "hyp": h}) + "\n")
            print(tag, Path(t).stem, res[Path(t).stem][tag], flush=True)
    json.dump(res, open(w / "eval.json", "w"), indent=1); print(json.dumps(res, indent=1))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["base", "train", "export", "eval"])
    ap.add_argument("--out", required=True); ap.add_argument("--nemo"); ap.add_argument("--root", default="")
    ap.add_argument("--train", default=str(ROOT / "ml/data/stt/manifests/train_all.jsonl"))
    ap.add_argument("--val", nargs="+", default=[str(ROOT / f"ml/data/stt/manifests/{n}.jsonl") for n in ("test_synth", "test_cov", "test_uwb")])
    ap.add_argument("--tests", nargs="+", default=[str(ROOT / f"ml/data/stt/manifests/test_{n}.jsonl") for n in ("synth", "cov", "atco2", "uwb", "atcosim")])   # gold: on the VPS (private recordings stay there)
    ap.add_argument("--epochs", type=int, default=3); ap.add_argument("--batch", type=int, default=16); ap.add_argument("--accum", type=int, default=2)
    ap.add_argument("--init", default=""); ap.add_argument("--workers", type=int, default=3); ap.add_argument("--maxdur", type=float, default=15.0); ap.add_argument("--base", default=""); ap.add_argument("--lr", type=float, default=5e-5); ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args(); {"base": cmd_base, "train": cmd_train, "export": cmd_export, "eval": cmd_eval}[a.cmd](a)


if __name__ == "__main__":
    main()
