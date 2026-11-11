"""Self-play results -> docs/spec/14-PILOT-SELFPLAY.md (and, through ml/report/md_report.py, the report page).
    python3 ml/selfplay/report.py [ml/data/selfplay/summary.json]"""
import json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATHS = sys.argv[1:] or [str(ROOT / "ml/data/selfplay/summary.json"), str(ROOT / "ml/data/selfplay-mixed/summary.json")]
RUNS = [json.loads(Path(p).read_text()) for p in PATHS if Path(p).exists()]
S = RUNS[0]
for R in RUNS[1:]:   # several runs (two parallel runways, one runway in mixed mode): add them up
    for m, n in zip(S["mistakes"], R["mistakes"]):
        m["injected"] += n["injected"]; m["caught"] += n["caught"]; m["examples"] = (m["examples"] + n["examples"])[:3]; m["misses"] += n["misses"]
    for k in ("injected", "caught"): S["total"][k] += R["total"][k]
    for side in ("goodController", "withAdversary"):
        for k in ("hours", "movements", "goArounds", "lines"): S[side][k] += R[side][k]
        for k, v in R[side]["mind"].items(): S[side]["mind"][k] = S[side]["mind"].get(k, 0) + v
    S["wallSeconds"] += R["wallSeconds"]; S["seeds"] += R["seeds"]
CONFIGS = "; ".join(f"{R['airport']} runway{'s' if ',' in R.get('ends', ',') else ''} {R.get('ends') or '27R,27L'}" for R in RUNS)

WHO = {
    "level reversed": "memory (ledger)", "heading reversed": "memory (ledger)",
    "line up, traffic on short final": "look-ahead + party line", "cross, traffic on short final": "look-ahead + party line",
    "cross, departure rolling": "look-ahead + party line", "cleared to land, runway occupied": "look-ahead + party line",
    "cleared to land, wrong runway": "aircraft state", "takeoff, traffic on short final": "aircraft state",
    "instruction for the wrong aircraft": "aircraft state", "descent below a safe level": "look-ahead (added after run 1)",
    "speed below what the aircraft can fly": "aircraft state", "sent to the ground frequency in the air": "look-ahead (added after run 1)",
}
g, a, t = S["goodController"], S["withAdversary"], S["total"]
pct = lambda c, n: "–" if not n else "100 %" if c == n else f"{min(99.9, 100 * c / n):.1f} %"
per_h = lambda n, h: f"{n / h:.1f}" if h else "–"
own = g["mind"]

md = [f"# Pilots against a careless controller: the self-play scoreboard", "",
      f"Status: results, 11 November 2026. {CONFIGS}: {S['seeds']} sessions of {S['minutesPerEpisode']} simulated minutes, each "
      f"played twice: once with only the game's AI controllers, once with an adversary adding mistakes. "
      f"CPU only, {S['wallSeconds'] // 60} minutes. Run it again with `bash ml/selfplay/run.sh`.", "",
      "## What was built today", "",
      "Four ideas from the pilot-brain pitch are in the game now. None of them uses a trained model yet: they are rules read "
      "from the simulator's state, so they are exact and testable, and they produce the labelled data the learned pilot will train on.", "",
      "| idea | what the pilots do now | where |", "|---|---|---|",
      "| Looking ahead | A crew cleared to land works out whether the runway will be clear when they get there. If not, they ask, at the clearance or on short final, before it becomes a go-around. A descent below the minimum safe altitude away from the field is questioned. | `src/lib/sim/pilotmind.ts` |",
      "| Party line | Pilots hear the other clearances on their frequency and quote them: \"we heard Speedbird 1 cleared to line up, confirm cleared to land?\" A go-around for wind makes the next aircraft on that approach ask for a wind check. A line-up or a crossing in front of traffic on short final is questioned. Converging traffic is reported by the aircraft that has it ahead. | `src/lib/sim/pilotmind.ts` |",
      "| Personalities | Every callsign has a crew for the whole flight: long-haul captain, line crew, new first officer, crew new to the airport, student pilot. It sets how fast they answer, how often they read back wrong, how many instructions they take in at once before \"say again, slowly\", hesitation in the wording and the pace of the voice. Stress (an emergency, go-arounds, low fuel, waiting) sharpens a captain and slows the others. | `src/lib/sim/persona.ts` |",
      "| Self-play with an adversary | The AI controllers run the airport; an adversary makes a controller's mistakes on the same frequencies. Each mistake is a labelled example, and the run scores the pilots. | `ml/selfplay/` |", "",
      "## The scoreboard", "",
      f"The adversary made **{t['injected']}** mistakes of 12 kinds; the pilots caught **{t['caught']}** ({pct(t['caught'], t['injected'])}). "
      "\"Caught\" means the pilot questioned or refused the instruction and nothing was executed.", "",
      "Read the number with care: the adversary's mistakes and the pilots' rules were written by the same hand, so this measures that the rules work inside a busy, running airport and do not misfire. It does not measure mistakes nobody has thought of yet; those come from new mistake kinds and, later, from real players.", "",
      "| the controller's mistake | made | caught | rate | caught by |", "|---|---|---|---|---|"]
for m in S["mistakes"]:
    md.append(f"| {m['kind']} | {m['injected']} | {m['caught']} | {pct(m['caught'], m['injected'])} | {WHO.get(m['kind'], '')} |")
never = [m["kind"] for m in S["mistakes"] if not m["injected"]]
if never:
    md += ["", "Not seen in this run (the situation did not come up while the adversary was looking): " + "; ".join(never) + ". They are covered by scripted story tests."]
md += ["", "## Do the pilots talk too much?", "",
       f"With only the AI controllers working ({g['hours']:.1f} hours, {g['movements']} movements, {g['lines']} radio lines), every call the pilots made on their own initiative is a possible false alarm:", "",
       "| call | count | per hour |", "|---|---|---|",
       f"| \"confirm cleared to land?\" (runway not clear on arrival) | {own.get('runwayCalls', 0)} | {per_h(own.get('runwayCalls', 0), g['hours'])} |",
       f"| converging traffic | {own.get('trafficCalls', 0)} | {per_h(own.get('trafficCalls', 0), g['hours'])} |",
       f"| wind check after a go-around ahead | {own.get('windChecks', 0)} | {per_h(own.get('windChecks', 0), g['hours'])} |", "",
       f"Go-arounds: {g['goArounds']} with the good controller, {a['goArounds']} with the adversary ({a['movements']} movements)."]
md += ["", "## Examples from the run", ""]
shown = 0
for m in S["mistakes"]:
    for ex in m["examples"][:1]:
        md += [f"**{m['kind']}** ({ex['crew']} crew; the pilot knew: {ex['knew']})", "", "```", f"controller: {ex['said']}", f"pilot:      {ex['reply']}", "```", ""]
        shown += 1
misses = [(m["kind"], x) for m in S["mistakes"] for x in m["misses"]]
md += ["## What the pilots still miss", ""]
if misses:
    md += ["Each miss is a rule to write or an example for the learned model:", ""]
    for kind, x in misses[:8]:
        md += [f"**{kind}** (the pilot knew: {x['knew']})", "", "```", f"controller: {x['said']}", f"pilot:      {x['reply']}", "```", ""]
    md += ["The speed case is not a pilot error: the simulator refuses any speed below the aircraft type's minimum, so this type can fly 100 knots (IndiGo also flies ATR 72 turboprops). The adversary's rule was too coarse.", ""]
else:
    md += ["Nothing in this run. The first run of the arena found two kinds nobody caught (a descent below a safe level, a hand-off to the ground frequency while airborne) and two needless traffic calls; all were fixed the same hour, which is the point of the arena.", ""]
md += ["## What this is for", "",
       "- **A quality bar.** The scoreboard runs on every change to the pilots, next to the story tests (20 today).",
       "- **Training data.** `ml/data/selfplay/episodes.jsonl` holds every dialogue with the state the pilot knew. The learned pilot model (spec 13, phases 3 to 5) trains on millions of these; the adversary is what puts the rare, dangerous cases in.",
       "- **Finding gaps.** New mistake kinds are a few lines each in `ml/selfplay/arena.ts`.", "",
       "## Next", "",
       "1. More mistake kinds: wrong callsign of a similar-sounding aircraft, forgotten aircraft, conflicting taxi routes, conditional clearances.",
       "2. The adversary learns: it searches for the mistakes the pilots miss, instead of drawing them at random.",
       "3. The same arena scores System 1 v2 (spec 12): the adversary speaks in free wording and through the speech models.",
       "4. The learned pilot (wording and timing) trains on the episodes, with these rules as its safety net."]
out = ROOT / "docs/spec/14-PILOT-SELFPLAY.md"
out.write_text("\n".join(md) + "\n")
subprocess.run([sys.executable, str(ROOT / "ml/report/md_report.py"), str(out), str(ROOT / "public/reports/pilot-selfplay.html"), "Pilot self-play", "results"], check=True)
print(out)
