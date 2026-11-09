"""Collect the server-class STT numbers into ml/stt/models/server.json (ml/stt/models/SERVER.md).

    python3 ml/stt/models/srv_summarize.py <us1.json,us2.json,...> <in1.json,...> [<latency.json> [<cascade_latency.json>]]

Accuracy from bench2's scorer (chain = nbest+S1, what the game runs: repair, n-best, S1 behind the rules);
latency from the raw rows (ms = one decode with the biasing on, ms_plain = the second, unbiased decode);
peak RSS / load time from <results>.run.json.
"""
import json, os, sys

R = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../bench2/results')
CHAIN = 'nbest+S1'

INFO = {   # download (MB, what is fetched), licence, biasing, Node path
    'srv-phonon': dict(model='FermionResearch/Phonon-2.5-English (5-value Parakeet TDT 0.6B v3)', runtime='fermion-research 0.2.15 CPU engine (C, avx512-vnni)',
                       download_mb=158, licence='weights CC-BY-4.0; fermion-research (CLI + native CPU engine) Apache-2.0', commercial='yes (attribution)',
                       biasing='hotwords: up to 25 words, +lambda per matching word piece in the greedy TDT decoder (used: callsign telephony words, lambda 2)',
                       node='neither: Python package + native .so; run as a sidecar (`fermion serve` gives an OpenAI-style /v1/audio/transcriptions) behind OPENATC_STT_URL'),
    'srv-p110-sherpa': dict(model='nvidia/parakeet-tdt_ctc-110m (TDT head), sherpa-onnx int8 build', runtime='sherpa-onnx 2.0.1 (onnxruntime)',
                            download_mb=108, licence='weights CC-BY-4.0; sherpa-onnx Apache-2.0', commercial='yes (attribution)',
                            biasing='hotwords: per-stream list, modified beam search (4 paths) with a context graph, score 1.5/token',
                            node='sherpa-onnx-node (prebuilt addon, createStream(hotwords))'),
    'srv-canary180': dict(model='nvidia/canary-180m-flash, istupakov int8 ONNX', runtime='onnx-asr 0.12 (onnxruntime 1.31)',
                          download_mb=204, licence='weights CC-BY-4.0; onnx-asr MIT', commercial='yes (attribution)',
                          biasing='none exposed (AED decoder: the prompt is task tokens only; a custom decode loop could add token boosts)',
                          node='sherpa-onnx-node (from_nemo_canary build) or onnxruntime-node + own decode loop; no hotwords'),
    'srv-hima': dict(model='Prahaladha/hima-asr-ONNX int8 (Qwen3-ASR-1.7B-initialised encoder + Gemma-3-270M writer, 11 Indian languages + English)',
                     runtime='hima_onnx.py (onnxruntime, numpy, tokenizers)', download_mb=600,
                     licence='Apache-2.0 + Gemma Terms of Use (writer from Gemma 3 270M)', commercial='yes, under the Gemma terms and prohibited-use policy',
                     biasing='none documented (LLM writer; a text prefix is untested and not what it was trained on)',
                     node='onnxruntime-node possible (2 ONNX graphs + numpy log-mel + tokenizer): a port of ~200 lines'),
    'srv-redux-sherpa': dict(model='moondream/parakeet-redux (ternary Parakeet TDT 0.6B v3), sherpa-onnx int8 build', runtime='sherpa-onnx 2.0.1',
                             download_mb=327, licence='weights CC-BY-4.0; sherpa-onnx Apache-2.0', commercial='yes (attribution)',
                             biasing='hotwords (as p110-sherpa)', node='sherpa-onnx-node'),
    'srv-ultra-sherpa': dict(model='moondream/parakeet-ultra (post-trained Parakeet TDT 0.6B v3), sherpa-onnx int8 build', runtime='sherpa-onnx 2.0.1',
                             download_mb=487, licence='weights CC-BY-4.0; sherpa-onnx Apache-2.0', commercial='yes (attribution)',
                             biasing='hotwords (as p110-sherpa)', node='sherpa-onnx-node'),
    'srv-redux-photon': dict(model='moondream/parakeet-redux, ternary weights', runtime='moondream 2.6.1 / Photon (kestrel 0.9.1, kestrel-kernels 0.7.4)',
                             download_mb=178, licence='weights CC-BY-4.0; Photon kernels PROPRIETARY (Kestrel Kernels licence: use needs a separate agreement with M87 Labs); sends usage telemetry to api.moondream.ai',
                             commercial='no, not without an agreement with M87 Labs (the open weights run under sherpa-onnx instead: srv-redux-sherpa)',
                             biasing='none exposed', node='neither (Python + proprietary native kernels)'),
    'srv-ultra-onnxasr': dict(model='ijar/parakeet-ultra-onnx-latin-int8', runtime='onnx-asr 0.12 (onnxruntime 1.31)',
                              download_mb=728, licence='CC-BY-4.0; onnx-asr MIT', commercial='yes (attribution)',
                              biasing='none in onnx-asr (greedy TDT); the same weights under sherpa-onnx take hotwords',
                              node='onnxruntime-node + own mel + TDT loop, or the sherpa-onnx build'),
    'srv-granite': dict(model='ibm-granite/granite-speech-5.0-470m-turboctc (multilingual release)', runtime='transformers 5.22 + torch 2.15 CPU, fp32',
                        download_mb=903, licence='Apache-2.0', commercial='yes',
                        biasing='none built in; CTC logits allow hotword-boosted prefix beam search (not tried)',
                        node='onnxruntime-node with a community ONNX export + own log-mel/delta front end + CTC greedy (not tried)'),
    'srv-tjs-whisper-base.en': dict(model='Whisper base.en (onnx-community), fp32 encoder + q8 decoder', runtime='transformers.js on onnxruntime-node (shipped)',
                                    download_mb=136, licence='MIT', commercial='yes', biasing='prompt (callsigns on frequency), 2-best with and without',
                                    node='in-process today (src/app/api/voice/stt/engine.ts)'),
}
INFO['srv-phonon2'] = dict(INFO['srv-phonon'], model='FermionResearch/Phonon-2 (25 languages, 5-value Parakeet TDT 0.6B v3)', download_mb=158,
                           note='CPU engine output joins digits to words ("United69 Descent to6000 ."); srv-phonon2fix re-spaces it')
INFO['srv-phonon2fix'] = dict(INFO['srv-phonon2'], note='srv-phonon2 with letters/digits re-spaced after the fact (not the engine output)')
INFO['srv-phonon-lam4'] = dict(INFO['srv-phonon'], note='hotword lambda 4 (US set only)')
INFO['srv-phonon-lam8'] = dict(INFO['srv-phonon'], note='hotword lambda 8: the biased decode degenerates (US set only)')
INFO['nemo-salm-context'] = dict(model='NVIDIA Nemotron 3.5 Transcribe 30B-A4B with callsign context (another agent, L4 GPU)', download_mb=None,
                                 licence='see the model card', commercial='-', biasing='context prompt', node='no (GPU service)')
INFO['nemo-asr06'] = dict(model='nvidia/nemotron-3.5-asr-streaming-0.6b (another agent, L4 GPU; transcripts reused)', download_mb=475,
                          licence='OpenMDW-1.1', commercial='yes', biasing='not tried', node='sherpa-onnx-node (streaming int8 build, 475 MB; not run here)')
INFO['tjs-whisper-base.en'] = dict(INFO['srv-tjs-whisper-base.en'], note='round-2 run (2 threads, heavy load); srv-tjs-whisper-base.en is the 3-thread re-run')
INFO['webspeech-google'] = dict(model='Google Web Speech in Chrome (round 2)', download_mb=0, licence='Google service', commercial='-', biasing='none (phrases rejected)', node='browser only')
for a in ('ultra-sherpa', 'p110-sherpa', 'redux-sherpa'):
    INFO[f'srv-casc-{a}'] = dict(model=f'srv-{a} first (2-best), Whisper base.en (2-best + prompt) only when its guesses are not understood',
                                 note='cascade built from the two result files (same rule as the scorer\'s a>b)')


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * q))] if xs else None


def rows_of(name):
    f = os.path.join(R, name + '.jsonl')
    if not os.path.exists(f): return []
    d = {}
    for l in open(f):
        if l.strip(): r = json.loads(l); d[r['wav']] = r
    return list(d.values())


def acc(summary, cand, group='all'):
    cand = cand.replace('.in', '')
    for r in reversed(summary):
        if r['cand'].replace('.in', '') == cand and r['group'] == group:
            return {'n': r['n'], 'exact': r[CHAIN], 'sent_wrong': r[f'{CHAIN}:wrong'], 'callsign': r[f'{CHAIN}:cs'], 'wer': r['wer'],
                    'exact_rules_S1_raw': r['rules+S1']}
    return None


def main():
    load = lambda arg: [r for f in arg.split(',') for r in json.load(open(f))]   # several scorer runs; later rows win
    us = load(sys.argv[1]); ind = load(sys.argv[2])
    out = {'how': {'us': 'ml/stt/bench2/clips, even ids (--every 2): 80 situations x clean/laptop/radio/late = 320 clips, Kokoro US/UK voices',
                   'in': 'ml/stt/bench2/clips_in, even ids: 80 situations x clean/laptop = 160 clips, Kokoro Hindi voices reading English (proxy)',
                   'chain': f'{CHAIN}: the game chain (repair + n-best + S1 2m-grpo-v1 behind the rules); exact = final command parses to the gold AST; '
                            'sent_wrong = sent without a check and wrong; callsign = right aircraft',
                   'latency': 'ms per transmission, one at a time, 3 threads, on this 8-core VPS shared with the browser-model agent (load average 10-27); '
                              'ms = the biased decode alone, ms_2best = biased + unbiased decodes (what an n-best of 2 costs)'},
           'engines': {}}
    names = sorted({r['cand'] for r in us} | {r['cand'].replace('.in', '') for r in ind})
    for name in names:
        if '@' in name: continue
        e = {'info': INFO.get(name, {})}
        for tag, summ in (('us', us), ('in', ind)):
            cand = name
            a = acc(summ, cand)
            if not a: continue
            for v in ('@prompt', '@plain'):
                b = acc(summ, cand + v)
                if b: a[v[1:]] = {k: b[k] for k in ('exact', 'sent_wrong', 'callsign', 'wer')}
            rows = rows_of(name if tag == 'us' else name + '.in') if not any(c in name for c in '+>') else []
            if rows:
                ms = [r['ms'] for r in rows]; ms2 = [r['ms'] + r.get('ms_plain', 0) for r in rows]
                a['ms_p50'], a['ms_p95'] = pct(ms, .5), pct(ms, .95)
                if any('ms_plain' in r for r in rows): a['ms_2best_p50'], a['ms_2best_p95'] = pct(ms2, .5), pct(ms2, .95)
                a['audio_s_mean'] = round(sum(r.get('sec', 0) for r in rows) / len(rows), 2)
                for c in ('clean', 'laptop', 'radio', 'late'):
                    g = acc(summ, cand, c)
                    if g: a.setdefault('by_cond', {})[c] = {k: g[k] for k in ('n', 'exact', 'sent_wrong', 'callsign', 'wer')}
            rj = os.path.join(R, (name if tag == 'us' else name + '.in') + '.jsonl.run.json')
            if os.path.exists(rj):
                m = json.load(open(rj)); a['peak_rss_mb'] = m.get('peak_rss_mb'); a['load_s'] = m.get('load_s')
            e[tag] = a
        out['engines'][name] = e
    for k, f in (('latency_quiet', sys.argv[3] if len(sys.argv) > 3 else ''), ('latency_cascade_est', sys.argv[4] if len(sys.argv) > 4 else '')):
        if f and os.path.exists(f): out[k] = json.load(open(f))
    dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server.json')
    json.dump(out, open(dst, 'w'), indent=1)
    print(f"{'engine':28} {'US exact':>8} {'wrong':>6} {'cs':>5} {'WER':>5} | {'IN exact':>8} {'wrong':>6} {'cs':>5} {'WER':>5} | {'p50':>5} {'p95':>5} {'RSS':>5}")
    for n, e in out['engines'].items():
        u, i = e.get('us', {}), e.get('in', {})
        f = lambda d, k: f"{d[k] * 100:.0f}%" if k in d else '-'
        print(f"{n:28} {f(u, 'exact'):>8} {f(u, 'sent_wrong'):>6} {f(u, 'callsign'):>5} {f(u, 'wer'):>5} | {f(i, 'exact'):>8} {f(i, 'sent_wrong'):>6} {f(i, 'callsign'):>5} {f(i, 'wer'):>5} | {u.get('ms_p50', '-'):>5} {u.get('ms_p95', '-'):>5} {u.get('peak_rss_mb', '-'):>5}")


main()
