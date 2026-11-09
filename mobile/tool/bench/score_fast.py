"""Faster variant of ml/stt/score.py for the phone-app report: same L0 (rules) and L1 (S1 model) definitions, but the
model only runs on rows the rules could not parse (that is all L0 + L1 needs). Usage: score_fast.py <dir> <name>..."""
import json, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path('/root/atc')
for p in ('ml/s1', 'ml/tokenizer', 'ml/data'):
    sys.path.insert(0, str(ROOT / p))
import compat  # noqa: F401,E402
import torch  # noqa: E402
from bpe import BPE  # noqa: E402
from model import GPT, Config  # noqa: E402
from decode import generate, CallsignTrie  # noqa: E402
from augment import stt_normalise  # noqa: E402

torch.set_num_threads(2)
d = Path(sys.argv[1])
clips = {c['i']: c for c in json.load(open(d / 'clips.json'))}
run = ROOT / 'ml/s1/runs/v1'
cfg = json.load(open(run / 'config.json'))
model = GPT(Config(**cfg['model'])); model.load_state_dict(torch.load(run / 'model.pt', map_location='cpu')); model.eval()
tok = BPE.load(str(ROOT / 'ml/tokenizer/atc.json'))
norm = lambda s: ' '.join(s.upper().replace(',', ' ').split())
for name in sys.argv[2:]:
    res = json.load(open(d / f'{name}.json')); rows = res['rows']
    rin = [{'heard': r['heard'], 'line': clips[r['i']]['line'], 'ctx': clips[r['i']]['ctx']} for r in rows]
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as t:
        json.dump(rin, t)
    l0 = json.loads(subprocess.run(['node', str(ROOT / 'ml/stt/score_l0.cjs'), t.name], capture_output=True, text=True, check=True).stdout)
    both = 0
    for s0, ri in zip(l0, rin):
        if s0['same']:
            both += 1; continue
        if s0['ok']:
            continue
        cs = [l.split()[0] for l in ri['ctx'].split('\n')[1:] if l.strip()]
        pred = tok.decode(generate(model, tok, tok.encode('<ctx>' + ri['ctx'] + '<said> ' + stt_normalise(ri['heard']) + '<cmd>'), trie=CallsignTrie(tok, cs))).strip()
        both += norm(pred) == norm(ri['line'])
    n = len(rows)
    print(json.dumps({'model': name, 'n': n, 'l0': round(sum(x['same'] for x in l0) / n, 3), 'l0_l1': round(both / n, 3)}), flush=True)
