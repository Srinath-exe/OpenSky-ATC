"""Transcribe the speech-to-text benchmark clips with a running `nemo-speech serve` (GPU session 2, ml/gpu/remote/nemotron_jobs.sh).

Modes:
  plain    /v1/audio/transcriptions, the server's default prompt
  context  /v1/chat/completions with the model card's "names and terms" instruction listing the aircraft on frequency
           (from the clip's game state, as the game's server prompt does) and the ATC vocabulary
Writes the JSONL rows ml/stt/bench2/score.ts reads: {wav, heard, alts, ms}.
    python nemo_client.py <clipdir> <out.jsonl> --mode plain|context [--port 8080] [--every 2]
"""
import base64, json, sys, time
from pathlib import Path
import requests

args = sys.argv[1:]
clipdir, out = Path(args[0]), Path(args[1])
opt = lambda k, d: args[args.index(k) + 1] if k in args else d
mode, port, every = opt('--mode', 'plain'), int(opt('--port', '8080')), int(opt('--every', '1'))
url = f'http://127.0.0.1:{port}'
meta = [json.loads(l) for l in open(clipdir / 'meta.jsonl')]
if every > 1:
    meta = [m for m in meta if int(m['id']) % every == 0]
done = {json.loads(l)['wav'] for l in open(out)} if out.exists() else set()
PHRASES = 'flight level, heading, runway, descend and maintain, climb and maintain, cleared to land, cleared for takeoff, contact tower, niner, squawk, hold short'


def names(ctx: str) -> list[str]:
    out = []
    for line in ctx.split('\n')[1:]:
        parts = line.split(' ')
        if len(parts) < 3:
            continue
        # "BAW273 speedbird 273 ARR APP ..." -> "Speedbird 273"
        i = next((k for k, p in enumerate(parts) if p in ('ARR', 'DEP')), None)
        spoken = ' '.join(parts[1:i]) if i else ''
        if spoken:
            out.append(' '.join(w.capitalize() if not w.isdigit() else w for w in spoken.split()))
    return out[:24]


with open(out, 'a') as f:
    for m in meta:
        if m['wav'] in done:
            continue
        wav = (clipdir / m['wav']).read_bytes()
        t0 = time.time()
        if mode == 'plain':
            r = requests.post(f'{url}/v1/audio/transcriptions', files={'file': (m['wav'], wav, 'audio/wav')}, data={'language': 'en'}, timeout=120)
            text = r.json().get('text', '') if r.ok else ''
        else:
            instr = f"Transcribe with punctuation and capitalization. The speech is in English. Context terms: {', '.join(names(m.get('ctx', '')))}, {PHRASES}."
            body = {'model': 'salm', 'temperature': 0, 'messages': [{'role': 'user', 'content': [
                {'type': 'text', 'text': instr},
                {'type': 'input_audio', 'input_audio': {'data': base64.b64encode(wav).decode(), 'format': 'wav'}}]}]}
            r = requests.post(f'{url}/v1/chat/completions', json=body, timeout=120)
            text = r.json()['choices'][0]['message']['content'] if r.ok else ''
        ms = round((time.time() - t0) * 1000)
        text = ' '.join(str(text).split())
        f.write(json.dumps({'wav': m['wav'], 'heard': text, 'alts': [text] if text else [], 'ms': ms, 'mode': mode, 'status': r.status_code}) + '\n'); f.flush()
print('done', out, flush=True)
