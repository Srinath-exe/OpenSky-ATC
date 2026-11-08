"""System One bake-off: the same ATC questions to every decision model (zero-shot, no training).

Per spoken command, two multiple-choice questions over the game state:
  aircraft     which aircraft did the controller call?  options = the spoken names of the aircraft in the state
  instruction  what kind of instruction was it?          options = 14 instruction kinds
Adapters:
  d1        LiquidAI/d1-omni-600M        decision model, encoder + decision head        (trust_remote_code, reviewed)
  von       wfzyx/von (von-sdk)          ModernBERT-large + option markers, Apache-2.0
  logits    any causal LM, training-free: options as letters A, B, C...; the answer is the softmax over the letter
            tokens after the prompt ("SemIf"-style). Default Qwen/Qwen3.5-0.8B.

    ml/.venv312/bin/python ml/system1/bench_all.py --model von --n 100
    ml/.venv312/bin/python ml/system1/bench_all.py --model logits --lm Qwen/Qwen3.5-0.8B --n 100
"""
import argparse, json, random, re, statistics, string, time
from pathlib import Path

try:
    import torch
except ImportError:          # the data converter (to_kev.py) imports this module without torch
    torch = None
DEVICE = "cpu"

ROOT = Path(__file__).resolve().parents[2]
KINDS = {
    "heading": "Turn or fly a heading", "altitude": "Climb or descend to an altitude", "speed": "Change speed",
    "direct": "Proceed direct to a fix", "ils": "Cleared for the ILS approach", "clearedLand": "Cleared to land",
    "takeoff": "Cleared for takeoff", "lineup": "Line up and wait", "taxi": "Taxi to a runway or a stand",
    "pushback": "Pushback or start-up approved", "holdPosition": "Hold position or hold short", "cross": "Cross a runway",
    "contact": "Contact another frequency", "ack": "Acknowledge only: roger, radar contact, standby or unable",
}
GOLD = {"heading": "heading", "altitude": "altitude", "speed": "speed", "direct": "direct", "ils": "ils", "clearedLand": "clearedLand",
        "takeoff": "takeoff", "lineup": "lineup", "taxi": "taxi", "pushback": "pushback", "startup": "pushback", "holdPosition": "holdPosition",
        "holdShort": "holdPosition", "cross": "cross", "contact": "contact", "roger": "ack", "radarContact": "ack", "standby": "ack", "unable": "ack"}


def aircraft(ctx):
    out = {}
    for line in ctx.split("\n")[1:]:
        m = re.match(r"^(\S+) (.+?) (ARR|DEP) ", line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def build(ex):
    ac = aircraft(ex["ctx"])
    state = "Aircraft on frequency: " + ", ".join(ac.values()) + f'.\nThe air traffic controller said: "{ex["said"]}"'
    qs = {"aircraft": {"type": "choice", "instructions": "Which aircraft did the controller call?", "criteria": ac},
          "instruction": {"type": "choice", "instructions": "What did the controller instruct the aircraft to do?", "criteria": KINDS}}
    return state, qs


# ---------- adapters: (state, questions) -> {qid: (choice, confidence)} ----------
def make_d1():
    from transformers import AutoModel
    m = AutoModel.from_pretrained("LiquidAI/d1-omni-600M", trust_remote_code=True, dtype=torch.float16 if DEVICE == "cuda" else torch.float32).to(DEVICE).eval()
    def ask(state, qs):
        with torch.inference_mode():
            a = m.system_one(state, qs)["answers"]
        return {k: (v["choice"], v["confidence"]) for k, v in a.items()}
    return ask


def make_von():
    import von
    from von import VonClient
    import os; os.environ.setdefault("VON_DEVICE", DEVICE)
    cli = VonClient(local=True)
    def ask(state, qs):
        r = cli.system_one(state=state, questions=qs)
        out = {}
        for k, v in r.answers.items():
            d = v.model_dump() if hasattr(v, "model_dump") else dict(v)
            out[k] = (d.get("choice"), d.get("confidence") or max((d.get("probabilities") or {0: 0}).values()))
        return out
    return ask


def _norm_answers(r):
    ans = r.answers if hasattr(r, "answers") else r["answers"] if isinstance(r, dict) and "answers" in r else r
    out = {}
    for k, v in ans.items():
        d = v.model_dump() if hasattr(v, "model_dump") else v if isinstance(v, dict) else vars(v)
        probs = d.get("probabilities") or {}
        out[k] = (d.get("choice"), d.get("confidence") if d.get("confidence") is not None else (max(probs.values()) if probs else 0.0))
    return out


def make_laya():
    import laya
    agent = laya.Agent("convaiinnovations/laya", device=DEVICE)
    return lambda state, qs: _norm_answers(agent.system_one(state, qs))


def make_http(url, model="kev"):
    """Any server speaking TypeSafe's System One API: POST {url}/v1/systemone {model, state, questions}."""
    import json as _j, urllib.request as _u
    def ask(state, qs):
        req = _u.Request(f"{url.rstrip('/')}/v1/systemone", data=_j.dumps({"model": model, "state": state, "questions": qs}).encode(), headers={"Content-Type": "application/json"})
        return _norm_answers(_j.loads(_u.urlopen(req, timeout=300).read()))
    return ask


def make_logits(name):
    from transformers import AutoTokenizer, AutoModelForCausalLM
    tok = AutoTokenizer.from_pretrained(name)
    lm = AutoModelForCausalLM.from_pretrained(name, dtype=torch.bfloat16 if DEVICE == "cuda" else torch.float32).to(DEVICE).eval()
    letters = string.ascii_uppercase
    def ask(state, qs):
        out = {}
        for qid, q in qs.items():
            keys = list(q["criteria"])
            opts = "\n".join(f"{letters[i]}. {q['criteria'][k]}" for i, k in enumerate(keys))
            msgs = [{"role": "user", "content": f"{state}\n\n{q['instructions']}\n{opts}\n\nAnswer with the letter only."}]
            try:
                prompt = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False)
            except TypeError:
                prompt = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
            ids = tok(prompt, return_tensors="pt").to(DEVICE)
            with torch.inference_mode():
                logits = lm(**ids).logits[0, -1]
            cand = [tok.encode(letters[i], add_special_tokens=False)[0] for i in range(len(keys))]
            p = torch.softmax(logits[cand].float(), -1)
            j = int(p.argmax())
            out[qid] = (keys[j], float(p[j]))
        return out
    return ask


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, choices=["d1", "von", "laya", "logits", "http"]); ap.add_argument("--lm", default="Qwen/Qwen3.5-0.8B"); ap.add_argument("--url", default="http://127.0.0.1:8009"); ap.add_argument("--name", default=None)
    ap.add_argument("--n", type=int, default=100); ap.add_argument("--threads", type=int, default=8); ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--data", default=str(ROOT / "ml/data/out/ds/val.jsonl")); ap.add_argument("--device", default="cpu")
    a = ap.parse_args()
    global DEVICE; DEVICE = a.device
    torch.set_num_threads(a.threads)
    rows = [json.loads(l) for l in open(a.data)]
    random.Random(a.seed).shuffle(rows)
    rows = [r for r in rows if r["line"] != "SAY AGAIN" and GOLD.get(r["kind"].split("+")[0])][: a.n]
    t0 = time.time()
    ask = {"d1": make_d1, "von": make_von, "laya": make_laya, "http": lambda: make_http(a.url)}.get(a.model, lambda: make_logits(a.lm))()
    load_s = time.time() - t0
    hit = {"aircraft": 0, "instruction": 0}; ms = []; conf = {"right": [], "wrong": []}; fails = []
    for ex in rows:
        state, qs = build(ex)
        t1 = time.perf_counter(); ans = ask(state, qs); ms.append((time.perf_counter() - t1) * 1000)
        gold = {"aircraft": ex["line"].split()[0], "instruction": GOLD[ex["kind"].split("+")[0]]}
        for q in hit:
            ok = ans[q][0] == gold[q]; hit[q] += ok
            if q == "aircraft":
                conf["right" if ok else "wrong"].append(ans[q][1])
        if ans["aircraft"][0] != gold["aircraft"] and len(fails) < 6:
            fails.append(f'{ex["said"]!r}: gold {gold["aircraft"]} got {ans["aircraft"][0]} ({ans["aircraft"][1]:.2f})')
    ms.sort()
    name = a.name or (a.model if a.model != "logits" else f"logits:{a.lm}")
    res = {"model": name, "n": len(rows), "aircraft_acc": round(hit["aircraft"] / len(rows), 3), "instruction_acc": round(hit["instruction"] / len(rows), 3),
           "ms_p50": round(ms[len(ms) // 2]), "ms_p95": round(ms[int(len(ms) * .95)]), "load_s": round(load_s),
           "conf_right": round(statistics.mean(conf["right"]), 3) if conf["right"] else None, "conf_wrong": round(statistics.mean(conf["wrong"]), 3) if conf["wrong"] else None,
           "threads": a.threads, "device": a.device}
    print(json.dumps(res))
    for f in fails:
        print("  ", f)
    out = ROOT / "ml/system1/out"; out.mkdir(parents=True, exist_ok=True)
    json.dump({"summary": res, "fails": fails}, open(out / f"bench-{re.sub(r'[^a-zA-Z0-9.]+', '_', name)}{'-gpu' if a.device == 'cuda' else ''}.json", "w"), indent=1)


if __name__ == "__main__":
    main()
