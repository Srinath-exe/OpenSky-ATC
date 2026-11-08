"""Load test an OpenAI-compatible server (vLLM) with ATC prompts (ml/README.md module 12, cloud inference).

For each concurrency level, fire N requests (each = one controller transmission: game state + transcript) and record
  TTFT    time to first token (prefill + queueing): what prefix caching and batching change most
  e2e     time to the full command line
  thpt    requests/s and generated tokens/s across all users
Prompts come from the validation set; many share a game state (same session, same moment), like real players would.

    python ml/serve/loadtest.py --url http://127.0.0.1:8000 --model atc --levels 1,4,16,64 --n 128 --out results/vllm-cache-on.json
"""
import argparse, asyncio, json, random, statistics, time
from pathlib import Path

import httpx


def prompt(ex):
    return f"### State\n{ex['ctx']}\n### Heard\n{ex['said']}\n### Command\n"


async def one(client, url, model, p):
    t0 = time.perf_counter(); ttft = None; text = ""
    async with client.stream("POST", f"{url}/v1/completions", json={"model": model, "prompt": p, "max_tokens": 40, "temperature": 0, "stop": ["\n"], "stream": True}) as r:
        async for line in r.aiter_lines():
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            chunk = json.loads(line[6:])["choices"][0].get("text", "")
            if chunk and ttft is None:
                ttft = time.perf_counter() - t0
            text += chunk
    return {"ttft": ttft or (time.perf_counter() - t0), "e2e": time.perf_counter() - t0, "chars": len(text)}


async def level(url, model, prompts, conc):
    sem = asyncio.Semaphore(conc)
    async with httpx.AsyncClient(timeout=120) as client:
        async def guarded(p):
            async with sem:
                return await one(client, url, model, p)
        t0 = time.perf_counter()
        res = await asyncio.gather(*(guarded(p) for p in prompts))
        wall = time.perf_counter() - t0
    q = lambda xs, f: sorted(xs)[min(len(xs) - 1, int(len(xs) * f))]
    tt = [r["ttft"] * 1000 for r in res]; ee = [r["e2e"] * 1000 for r in res]
    return {"concurrency": conc, "n": len(res), "ttft_p50_ms": round(statistics.median(tt), 1), "ttft_p95_ms": round(q(tt, .95), 1),
            "e2e_p50_ms": round(statistics.median(ee), 1), "e2e_p95_ms": round(q(ee, .95), 1), "req_per_s": round(len(res) / wall, 1),
            "out_tokens_per_s": round(sum(r["chars"] for r in res) / 4 / wall)}   # ~4 chars per token for command lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8000"); ap.add_argument("--model", default="atc")
    ap.add_argument("--data", default="ml/data/out/ds/val.jsonl"); ap.add_argument("--levels", default="1,4,16,64")
    ap.add_argument("--n", type=int, default=128); ap.add_argument("--out", required=True); ap.add_argument("--tag", default="")
    a = ap.parse_args()
    rows = [json.loads(l) for l in open(a.data)]
    random.Random(0).shuffle(rows)
    prompts = [prompt(r) for r in rows[: a.n]]
    asyncio.run(level(a.url, a.model, prompts[:8], 4))          # warm-up (CUDA graphs, first-time compile)
    out = []
    for c in [int(x) for x in a.levels.split(",")]:
        r = asyncio.run(level(a.url, a.model, prompts, c)); r["tag"] = a.tag
        print(json.dumps(r), flush=True); out.append(r)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
