"""Server-class STT candidates on the bench2 clip sets (ml/stt/models/SERVER.md). Measurement only.

    <venv>/bin/python ml/stt/models/srv_run.py <engine> <clipdir> <out.jsonl> [--every 2] [--threads 3] [--hotwords] [--limit N]

Writes one row per clip in bench2's format (ml/stt/bench2/score.ts `Row`): {wav, heard, alts, decodes, ms, sec}.
With --hotwords and an engine that can be biased: decodes = [biased, plain], heard = biased, ms = biased decode
only (ms_plain separately), so the scorer's @prompt / @plain views are the ablation. One clip at a time.
Peak RSS and load time go to <out>.run.json.
"""
import json, os, re, sys, time, wave, resource

argv = sys.argv[1:]
def opt(k, d=None):
    return argv[argv.index(k) + 1] if k in argv else d
ENGINE, CLIPDIR, OUT = argv[0], argv[1], argv[2]
EVERY = int(opt('--every', '1')); THREADS = int(opt('--threads', '3')); LIMIT = int(opt('--limit', '0')) or None
HOT = '--hotwords' in argv; LAM = opt('--lam')
for v in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'FERMION_CPU_THREADS'):
    os.environ[v] = str(THREADS)
import numpy as np


def load_clips(d):
    rows = [json.loads(l) for l in open(os.path.join(d, 'meta.jsonl')) if l.strip()]
    out = []
    for r in rows:
        if not (r.get('wav') and r.get('ctx') and r.get('line')): continue
        if not os.path.exists(os.path.join(d, r['wav'])): continue
        if EVERY > 1 and r.get('id') and int(r['id']) % EVERY: continue
        out.append(r)
    return out


def names_from_ctx(ctx):
    out = []
    for l in ctx.split('\n')[1:]:
        m = re.match(r'^\S+ (.+?) (ARR|DEP) ', l)
        if m: out.append(m.group(1))
    return out


def hotwords_from(names):
    """Telephony words of the callsigns on frequency ("speedbird 50" -> "speedbird"), distinct, at most 25."""
    seen = []
    for n in names:
        w = ' '.join(t for t in n.split() if not t.isdigit()).strip()
        if w and w not in seen: seen.append(w)
    return seen[:25]


def read_wav(p):
    with wave.open(p) as w:
        assert w.getframerate() == 16000 and w.getsampwidth() == 2
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        if w.getnchannels() > 1: x = x[::w.getnchannels()]
    return x.astype(np.float32) / 32768.0


# ---------------- engines: each returns (transcribe(path, audio, hot|None) -> text, can_bias) ----------------

def eng_phonon(name='phonon-2.5-en'):
    from fermion._speech import backends, fetch
    from fermion.transcribe import _resolve
    repo, key, pin, local_dir = _resolve(name)
    kind = backends.resolve('bench'); backends.require_engine_for(kind, pin.get('backend', ''))
    mdir = local_dir if local_dir is not None else fetch.ensure(repo, key, pin)
    sp = backends.load(kind, mdir, profile=key, backend=pin['backend'], quiet=True)
    print(json.dumps({'describe': sp.describe()}, default=str)[:600], file=sys.stderr)
    def tr(path, audio, hot):
        sp.set_hotwords([w.title() for w in hot] if hot else [], lam=float(LAM) if (hot and LAM) else None)
        return sp.transcribe_detailed(path).triple()[0]
    return tr, True


def eng_photon(model):
    import moondream as md
    sp = md.photon(model, device='cpu', cpu_threads=THREADS)
    sp.__enter__()
    def tr(path, audio, hot):
        return sp.transcribe(audio=path)['text']
    return tr, False


def eng_onnxasr(kind, path, quant=None):
    import onnx_asr, onnxruntime as rt
    so = rt.SessionOptions(); so.intra_op_num_threads = THREADS; so.inter_op_num_threads = 1
    m = onnx_asr.load_model(kind, path, quantization=quant, sess_options=so)
    if kind == 'nemo-conformer-aed':
        def tr(p, audio, hot): return m.recognize(audio, sample_rate=16000, language='en', pnc=True)
    else:
        def tr(p, audio, hot): return m.recognize(audio, sample_rate=16000)
    return tr, False


def sherpa_bpe_vocab(d):
    """sherpa needs a sentencepiece-style vocab to split hotwords into pieces; NeMo builds ship tokens.txt only.
    Score -1 per piece: the segmentation with the fewest pieces wins."""
    out = os.path.join(d, 'bpe.vocab.srv')
    if not os.path.exists(out):
        with open(os.path.join(d, 'tokens.txt')) as f, open(out, 'w') as g:
            for l in f:
                t = l.rstrip('\n').rsplit(' ', 1)[0]
                if t and not t.startswith('<'): g.write(f'{t}\t-1\n')
    return out


def eng_sherpa(d, beam):
    import sherpa_onnx
    f = lambda pre: next(os.path.join(d, x) for x in sorted(os.listdir(d)) if x.startswith(pre) and x.endswith('.onnx'))
    kw = dict(encoder=f('encoder'), decoder=f('decoder'), joiner=f('joiner'), tokens=os.path.join(d, 'tokens.txt'),
              num_threads=THREADS, model_type='nemo_transducer', decoding_method='modified_beam_search' if beam else 'greedy_search')
    if beam:
        hwf = os.path.join(d, 'hotwords.srv.txt'); open(hwf, 'w').write('SPEEDBIRD\n')   # placeholder; per-stream lists below
        kw.update(hotwords_file=hwf, hotwords_score=float(LAM or 1.5), modeling_unit='bpe', bpe_vocab=sherpa_bpe_vocab(d), max_active_paths=4)
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(**kw)
    def tr(p, audio, hot):
        hw = '/'.join(v for h in hot for v in dict.fromkeys([h.lower(), h.title()])) if hot else ''
        s = rec.create_stream(hotwords=hw) if (beam and hot) else rec.create_stream()
        s.accept_waveform(16000, audio); rec.decode_stream(s)
        return s.result.text
    return tr, beam


def eng_sherpa_canary(d):
    import sherpa_onnx
    f = lambda pre: next(os.path.join(d, x) for x in sorted(os.listdir(d)) if x.startswith(pre) and x.endswith('.onnx'))
    rec = sherpa_onnx.OfflineRecognizer.from_nemo_canary(encoder=f('encoder'), decoder=f('decoder'), tokens=os.path.join(d, 'tokens.txt'),
                                                         num_threads=THREADS, src_lang='en', tgt_lang='en', use_pnc=True)
    def tr(p, audio, hot):
        s = rec.create_stream(); s.accept_waveform(16000, audio); rec.decode_stream(s); return s.result.text
    return tr, False


def eng_granite(path):
    import torch
    torch.set_num_threads(THREADS); torch.set_num_interop_threads(1)
    from transformers import AutoModelForCTC, AutoProcessor
    proc = AutoProcessor.from_pretrained(path); model = AutoModelForCTC.from_pretrained(path, dtype=torch.float32).eval()
    def tr(p, audio, hot):
        with torch.inference_mode():
            inp = proc([audio], sampling_rate=16000)
            out = model.generate(**inp)
        return proc.batch_decode(out, skip_special_tokens=True)[0]
    return tr, False


def eng_hima(d, precision='int8'):
    import importlib.util
    spec = importlib.util.spec_from_file_location('hima_onnx', os.path.join(d, 'hima_onnx.py'))
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    m = mod.HimaONNX(d, precision=precision, threads=THREADS)
    def tr(p, audio, hot): return m.transcribe(audio, language='en', sampling_rate=16000)
    return tr, False


def make(engine):
    M = os.path.join(os.path.dirname(os.path.abspath(__file__)))
    if engine == 'phonon': return eng_phonon()
    if engine == 'phonon2': return eng_phonon('phonon-2')
    if engine == 'redux-photon': return eng_photon('moondream/parakeet-redux')
    if engine == 'ultra-onnxasr': return eng_onnxasr('nemo-conformer-tdt', os.path.join(M, 'parakeet-ultra-int8'))
    if engine == 'canary-onnxasr': return eng_onnxasr('nemo-conformer-aed', os.path.join(M, 'canary-180m-flash-onnx'), 'int8')
    if engine == 'p110-onnxasr': return eng_onnxasr('nemo-conformer-tdt', os.path.join(M, 'parakeet-110m-onnx'), 'int8')
    if engine.startswith('sherpa-'):   # sherpa-<dir suffix>[:beam]
        name, _, beam = engine[len('sherpa-'):].partition(':')
        d = os.path.join(M, 'sherpa', name)
        if 'canary' in name: return eng_sherpa_canary(d)
        return eng_sherpa(d, beam == 'beam')
    if engine == 'granite': return eng_granite(os.path.join(M, 'granite-turboctc'))
    if engine == 'hima': return eng_hima(os.path.join(M, 'hima-onnx'))
    raise SystemExit(f'unknown engine {engine}')


def main():
    clips = load_clips(CLIPDIR)
    if LIMIT: clips = clips[:LIMIT]
    done = set()
    if os.path.exists(OUT):
        done = {json.loads(l)['wav'] for l in open(OUT) if l.strip()}
    t0 = time.time(); tr, can_bias = make(ENGINE); load_s = time.time() - t0
    rss_load = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    tr(os.path.join(CLIPDIR, clips[0]['wav']), read_wav(os.path.join(CLIPDIR, clips[0]['wav'])), None)   # warm-up
    print(json.dumps({'engine': ENGINE, 'load_s': round(load_s, 1), 'clips': len(clips), 'done': len(done), 'bias': HOT and can_bias}), file=sys.stderr)
    n = 0
    with open(OUT, 'a') as fo:
        for c in clips:
            if c['wav'] in done: continue
            p = os.path.join(CLIPDIR, c['wav']); audio = read_wav(p)
            hot = hotwords_from(names_from_ctx(c['ctx'])) if (HOT and can_bias) else None
            t = time.perf_counter(); a = (tr(p, audio, hot) or '').strip(); ms = (time.perf_counter() - t) * 1000
            row = {'wav': c['wav'], 'heard': a, 'alts': [a] if a else [], 'decodes': [a], 'ms': round(ms), 'sec': round(len(audio) / 16000, 2)}
            if hot:
                t = time.perf_counter(); b = (tr(p, audio, None) or '').strip(); ms_b = (time.perf_counter() - t) * 1000
                row.update(alts=[x for i, x in enumerate([a, b]) if x and x not in [a, b][:i]], decodes=[a, b], ms_plain=round(ms_b))
            fo.write(json.dumps(row) + '\n'); fo.flush(); n += 1
            if n % 40 == 0: print(json.dumps({'n': n, 'elapsed_s': round(time.time() - t0)}), file=sys.stderr)
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    meta = {'engine': ENGINE, 'clipdir': CLIPDIR, 'threads': THREADS, 'hotwords': HOT and can_bias, 'lam': LAM, 'load_s': round(load_s, 1),
            'rss_after_load_mb': round(rss_load), 'peak_rss_mb': round(peak), 'clips': n, 'elapsed_s': round(time.time() - t0)}
    json.dump(meta, open(OUT + '.run.json', 'w'))
    print(json.dumps(meta), file=sys.stderr)


main()
