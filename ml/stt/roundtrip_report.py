"""Where the time goes in a voice round trip: the attempts saved by /reports/voice-roundtrip.html (engine "roundtrip"
in ml/data/gold/live, with per-step timings in ms), summarised per step.

    python3 ml/stt/roundtrip_report.py [ml/data/gold/live] [--last N]
"""
import json, statistics, sys
from pathlib import Path

args = [a for a in sys.argv[1:] if not a.startswith('--')]
d = Path(args[0] if args else Path(__file__).resolve().parents[2] / 'ml/data/gold/live')
last = int(sys.argv[sys.argv.index('--last') + 1]) if '--last' in sys.argv else 0
rows = [r for r in (json.loads(p.read_text()) for p in sorted(d.glob('live-*.json'))) if r.get('engine') == 'roundtrip' and r.get('timings')]
rows = rows[-last:] if last else rows
if not rows:
    sys.exit(f'no round trips in {d}')

STEPS = [('tailMs', 'release tail'), ('sttMs', 'speech-to-text (Parakeet)'), ('whisperMs', 'second opinion (Whisper)'),
         ('undMs', 'reading the command (rules + S1)'), ('s1Ms', '  of which the S1 model'), ('readbackMs', 'pilot readback text'),
         ('voiceMs', 'pilot voice to first sound'), ('totalMs', 'TOTAL let go -> pilot voice')]
DETAIL = [('finalRttMs', 'last stream request round trip'), ('tailModelMs', 'last phrase on the server'), ('drainMs', 'chunk in flight at release'),
          ('segments', 'phrases per transmission'), ('ttsFirstSynthMs', 'first clause synthesis'), ('audioS', 'seconds spoken')]

def stats(key, only_sent=False):
    v = [r['timings'][key] for r in rows if key in r['timings'] and r['timings'][key] >= 0 and (r.get('ok') or not only_sent)]
    if not v:
        return None
    v.sort()
    return len(v), statistics.median(v), v[int(0.9 * (len(v) - 1))], statistics.mean(v)

sent = sum(1 for r in rows if r.get('ok'))
print(f'{len(rows)} round trips ({sent} sent) in {d}\n')
print(f"{'step':40} {'n':>4} {'median':>8} {'p90':>8} {'mean':>8}")
for k, name in STEPS + [(None, None)] + DETAIL:
    if k is None:
        print(); continue
    s = stats(k, only_sent=k in ('voiceMs', 'totalMs', 'readbackMs'))
    if s:
        unit = '' if k in ('segments', 'audioS') else ' ms'
        print(f'{name:40} {s[0]:4} {s[1]:8.0f} {s[2]:8.0f} {s[3]:8.0f}{unit}')
print('\nlast 10:')
for r in rows[-10:]:
    t = r['timings']
    print(f"  {r['id'][-9:]} {'sent' if r.get('ok') else 'no  '} total {t.get('totalMs', -1):6.0f}  tail {t.get('tailMs', 0):4.0f}  stt {t.get('sttMs', 0):5.0f}"
          f"  whisper {t.get('whisperMs', 0):5.0f}  read {t.get('undMs', 0):5.0f}  voice {t.get('voiceMs', -1):5.0f}  | {r.get('line') or r.get('error') or ''}")
