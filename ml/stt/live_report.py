"""Summarise the owner's live push-to-talk attempts (ml/data/gold/live/, saved by src/lib/voice/asr-diag.ts).

Each attempt holds the audio, what every recogniser heard, and what the game decided. This prints, per engine and accent,
how often the command was sent / left to check / said again, and lists every attempt so the misses can be read.
    python3 ml/stt/live_report.py [ml/data/gold/live] [--last N]
"""
import json, sys
from collections import Counter, defaultdict
from pathlib import Path

args = [a for a in sys.argv[1:] if not a.startswith('--')]
d = Path(args[0] if args else Path(__file__).resolve().parents[2] / 'ml/data/gold/live')
last = int(sys.argv[sys.argv.index('--last') + 1]) if '--last' in sys.argv else 0
rows = sorted((json.loads(p.read_text()) for p in d.glob('live-*.json')), key=lambda r: r.get('id', ''))
if last:
    rows = rows[-last:]
if not rows:
    sys.exit(f'no live attempts in {d}')

def outcome(r):
    return 'sent' if r.get('ok') else 'say again' if r.get('sayAgain') else 'nothing heard' if not r.get('line') else 'check'

by = defaultdict(Counter)
for r in rows:
    by[(r.get('page'), r.get('engine'), r.get('accent'))][outcome(r)] += 1
print(f'{len(rows)} attempts in {d}\n')
print(f"{'page':6} {'engine':16} {'accent':7} {'n':>4}  sent  check  say-again  nothing")
for (page, eng, acc), c in sorted(by.items(), key=lambda kv: -sum(kv[1].values())):
    n = sum(c.values())
    print(f"{page or '-':6} {eng or '-':16} {acc or '-':7} {n:4}  {c['sent']:4}  {c['check']:5}  {c['say again']:9}  {c['nothing heard']:7}")
print()
for r in rows:
    t = r.get('transcripts', {})
    print(f"{r['id']}  {r.get('page')}/{r.get('engine')}/{r.get('accent')}  {r.get('sec')} s  -> {outcome(r)}: {r.get('line') or ''}")
    for k, v in t.items():
        print(f"    {k:8} {v[0] if v else ''}" + (f"   (+{len(v) - 1} more)" if len(v) > 1 else ''))
    if r.get('expected'):
        print(f"    expected (if you read the example): {r['expected']}")
    if r.get('error') and not r.get('ok'):
        print(f"    why: {r['error']}")
