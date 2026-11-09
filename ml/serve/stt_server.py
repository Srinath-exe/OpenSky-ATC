"""Optional speech-to-text service: faster-whisper (CTranslate2, int8) behind the same API as the in-process engine.

NOT installed or started (that needs the owner's OK: scripts/openatc-stt.service). The game's /api/voice/stt keeps its
guards (size, rate, queue, timeout) and forwards to this service when OPENATC_STT_URL is set, e.g.
OPENATC_STT_URL=http://127.0.0.1:3006 in the openatc unit. ml/stt/RESULTS2.md compares the two.

    ml/stt/.venv/bin/python ml/serve/stt_server.py --port 3006 --model base.en --threads 2
POST /transcribe  body: 16-bit PCM 16 kHz mono, X-STT-Names: encodeURIComponent(JSON list of spoken callsigns)
                  -> {"text", "alternatives", "ms", "model"}
GET  /health      -> {"ok": true, "model"}
"""
import argparse, json, re, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

MAX_BYTES = 1_000_000


def build_prompt(names):
    seen, lst = set(), []
    for n in names:
        n = re.sub(r"[^a-z0-9 ]+", " ", str(n).lower()).strip()
        if n and n not in seen:
            seen.add(n); lst.append(re.sub(r"\b[a-z]", lambda m: m.group(0).upper(), n))
    lst = lst[:24]
    if not lst:
        return None
    return f"Air traffic control. {', '.join(lst)}. Climb, descend and maintain flight level, turn left heading, reduce speed, cleared to land runway, contact tower."


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3006); ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--model", default="base.en"); ap.add_argument("--threads", type=int, default=2)
    a = ap.parse_args()
    from faster_whisper import WhisperModel
    model = WhisperModel(a.model, device="cpu", compute_type="int8", cpu_threads=a.threads, download_root=str(Path.home() / ".cache/openatc-stt/fw"))
    lock = threading.Lock()   # one transcription at a time; the Next route queues and rate-limits in front of this

    def run(audio, prompt):
        segs, _ = model.transcribe(audio, language="en", beam_size=1, initial_prompt=prompt, condition_on_previous_text=False,
                                   without_timestamps=True, vad_filter=False, temperature=0.0)
        return " ".join(s.text.strip() for s in segs).strip()

    class H(BaseHTTPRequestHandler):
        def _json(self, code, body):
            b = json.dumps(body).encode(); self.send_response(code)
            self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)

        def do_GET(self):
            self._json(200, {"ok": True, "model": a.model}) if self.path.startswith("/health") else self._json(404, {"error": "not found"})

        def do_POST(self):
            if not self.path.startswith("/transcribe"):
                return self._json(404, {"error": "not found"})
            n = int(self.headers.get("content-length") or 0)
            if n <= 0 or n > MAX_BYTES or n % 2:
                return self._json(413, {"error": "bad audio size"})
            audio = np.frombuffer(self.rfile.read(n), dtype="<i2").astype(np.float32) / 32768.0
            try:
                names = json.loads(urllib.parse.unquote(self.headers.get("x-stt-names") or "[]"))
            except Exception:
                names = []
            prompt = build_prompt(names if isinstance(names, list) else [])
            t0 = time.perf_counter()
            with lock:
                alts = [run(audio, prompt)]
                if prompt and self.headers.get("x-stt-alts") != "0":
                    alts.append(run(audio, None))
            uniq = list(dict.fromkeys(x for x in alts if x))
            self._json(200, {"text": uniq[0] if uniq else "", "alternatives": uniq, "ms": round((time.perf_counter() - t0) * 1000), "model": f"faster-whisper {a.model}"})

        def log_message(self, *args):
            pass

    print(json.dumps({"listening": f"http://{a.host}:{a.port}", "model": a.model}), flush=True)
    ThreadingHTTPServer((a.host, a.port), H).serve_forever()


if __name__ == "__main__":
    main()
