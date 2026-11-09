"""Compact table from score.ts summaries: old chain (rules+S1), new chain (n-best + repair + S1), sent wrong, callsign, WER.
    python3 ml/stt/bench2/edge_table.py <summary.json ...> [--group all]
"""
import json, sys
args = [a for a in sys.argv[1:] if not a.startswith('--')]
group = sys.argv[sys.argv.index('--group') + 1] if '--group' in sys.argv else 'all'
print(f"{'engine':34} {'n':>4} {'old':>5} {'new':>5} {'wrong':>5} {'cs':>5} {'wer':>5}")
for f in args:
    if f == group:
        continue
    for r in json.load(open(f)):
        if r['group'] != group:
            continue
        p = lambda k: f"{100 * r[k]:5.1f}"
        print(f"{r['cand'][:34]:34} {r['n']:4} {p('rules+S1')} {p('nbest+S1')} {p('nbest+S1:wrong')} {p('nbest+S1:cs')} {p('wer')}")
