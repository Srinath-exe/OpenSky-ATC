"""Tables for ml/s1/CALLSIGN_SCORING.md from ml/s1/results/cs_{swap,grpo}.json (ml/s1/callsign_scoring.py).

    ml/.venv/bin/python ml/s1/callsign_report.py            -> prints the markdown tables, writes results/summary.json
"""
import json, math
from pathlib import Path

D = Path(__file__).resolve().parent / "results"
MODELS = {"swap": "2m-swap-v1 (shipped)", "grpo": "2m-grpo-v1 (GRPO)"}
SETS = {"val": "val", "sydney": "Sydney (unseen)", "stt": "real recognisers"}


def mcnemar_p(b, c):
    """Exact two-sided McNemar on discordant pairs (as ml/rl/report.py)."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def pf(p):
    return "p<0.001" if p < 0.001 else f"p={p:.2f}" if p >= 0.01 else f"p={p:.3f}"


def paired(rows, a, b, key):
    """(fixed, broken) going from variant a to b; key = 'exact' or 'callsign'."""
    def ok(r, v):
        return r[v] == r["gold"] if key == "exact" else r[v].split()[:1] == r["gold"].split()[:1]
    fx = sum(ok(r, b) and not ok(r, a) for r in rows); br = sum(ok(r, a) and not ok(r, b) for r in rows)
    return fx, br


def main():
    out = {}
    print("| model | set | n | trie exact / cs | sum exact / cs | mean exact / cs | sum vs trie (exact) | mean vs sum (exact) | say-again missed / false (trie, sum, mean) |")
    print("|---|---|---:|---|---|---|---|---|---|")
    for m, mname in MODELS.items():
        f = D / f"cs_{m}.json"
        if not f.exists():
            continue
        d = json.load(open(f)); out[m] = {}
        for s, sname in SETS.items():
            S = d["summary"][s]; R = d["rows"][s]
            fx, br = paired(R, "trie", "sum", "exact"); fx2, br2 = paired(R, "sum", "mean", "exact"); fx3, br3 = paired(R, "trie", "mean", "exact")
            cfx, cbr = paired(R, "trie", "sum", "callsign")
            out[m][s] = {"n": S["trie"]["n"], **{v: S[v] for v in ("trie", "sum", "sum_nb", "mean", "beam2", "beam4", "beam8")}, "cost": S["_cost"],
                         "sum_vs_trie": {"fixed": fx, "broken": br, "p": mcnemar_p(fx, br), "cs_fixed": cfx, "cs_broken": cbr, "cs_p": mcnemar_p(cfx, cbr)},
                         "mean_vs_sum": {"fixed": fx2, "broken": br2, "p": mcnemar_p(fx2, br2)},
                         "mean_vs_trie": {"fixed": fx3, "broken": br3, "p": mcnemar_p(fx3, br3)}}
            e = lambda v: f"{100 * S[v]['exact']:.1f} / {100 * S[v]['callsign']:.1f}"
            sa = lambda v: f"{S[v]['sa_missed']}/{S[v]['sa_false']}"
            print(f"| {mname} | {sname} | {S['trie']['n']} | {e('trie')} | {e('sum')} | {e('mean')} | +{fx} −{br} ({pf(mcnemar_p(fx, br))}) | +{fx2} −{br2} ({pf(mcnemar_p(fx2, br2))}) | {sa('trie')}, {sa('sum')}, {sa('mean')} |")
    print()
    print("| model | set | trie steps | all candidates (shared trie) | beam 4 | best-first sum, cap 0 / 8 | A* mean, cap 0 / 1 |")
    print("|---|---|---:|---:|---:|---:|---:|")
    for m, mname in MODELS.items():
        for s, sname in SETS.items():
            if m not in out:
                continue
            S = out[m][s]; c = S["cost"]
            print(f"| {mname} | {sname} | {S['trie']['steps_mean']} | {S['sum']['steps_mean']} | {S['beam4']['steps_mean']} | "
                  f"{c['best_first_cap0_steps_mean']} / {c['best_first_cap8_steps_mean']} | {c['astar_mean_cap0_steps_mean']} / {c['astar_mean_cap1_steps_mean']} |")
    json.dump(out, open(D / "summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
