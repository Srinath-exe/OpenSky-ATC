"""Plain-language training data (docs/spec/15-FREE-WORDING.md): the same game situations as ml/data/augment.py, said
the way a controller talks when not reading the book.

For each exporter record the standard spoken phrase is taken apart (verb phrase / values) and the verb phrase is
replaced by one of 10-20 everyday wordings per command kind; every value (level, heading, runway, fix, frequency) is
copied from the standard phrase, so the label (the game's command line) stays exact. Lines that are not commands
("how's the ride?") are added with the target SAY AGAIN.

Text style = what the fine-tuned speech models write: lower-case spoken words, digits as words.
The held-out exam (ml/s1/freeword/held.json) is never read here; `--leak` reports how many of its lines a template
would reproduce word for word.

    python3 ml/data/plain.py ml/data/out3/*.jsonl --out ml/data/out5/ds
"""
import argparse, json, random, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from augment import stt_normalise, ICAO_TO_STT  # noqa: E402

T = {}   # kind -> function(body, rng) -> plain body | None


def kind(name):
    def deco(f): T[name] = f; return f
    return deco


def pick(rng, xs): return xs[rng.randrange(len(xs))]


CLIMB = ["climb {v}", "climb to {v}", "climb up to {v}", "go up to {v}", "up to {v}", "continue climb {v}", "climb now {v}", "you can climb {v}",
         "start climbing to {v}", "take it up to {v}", "{v} for you climb", "climb on up to {v}", "i need you up at {v}", "higher is available climb {v}",
         "let's go up to {v}", "climb and maintain {v}", "keep climbing to {v}", "on up to {v}"]
DESCEND = ["descend {v}", "descend to {v}", "come down to {v}", "down to {v}", "go down to {v}", "start down to {v}", "start your descent to {v}",
           "begin descent {v}", "descend now to {v}", "drop down to {v}", "you can descend {v}", "let's get you down to {v}", "take it down to {v}",
           "bring it down to {v}", "{v} for you descend", "lower is available descend {v}", "continue descent {v}", "i need you down at {v}",
           "descend and maintain {v}", "keep it coming down to {v}"]


@kind("altitude")
def _alt(b, rng):
    m = re.match(r"^(climb|descend)(?: and maintain| to)? (?P<v>.+?)(?P<x> expedite)?$", b)
    if not m: return None
    s = pick(rng, CLIMB if m.group(1) == "climb" else DESCEND).format(v=m.group("v"))
    return s + (pick(rng, [" expedite", " and expedite", " expedite please"]) if m.group("x") else "")


HDG = ["heading {v}", "fly heading {v}", "turn heading {v}", "turn to heading {v}", "make your heading {v}", "new heading {v}", "take up heading {v}",
       "come to heading {v}", "heading now {v}", "roll onto heading {v}", "fly a heading of {v}", "i need heading {v}", "give me heading {v}",
       "turn onto heading {v}", "your heading {v}", "vector heading {v}", "steer heading {v}", "heading {v} please", "turn to a heading of {v}"]
HDG_DIR = ["turn {d} heading {v}", "{d} turn heading {v}", "turn {d} to heading {v}", "{d} heading {v}", "come {d} heading {v}",
           "make a {d} turn heading {v}", "{d} turn onto heading {v}", "turn {d} now heading {v}"]


@kind("heading")
def _hdg(b, rng):
    m = re.match(r"^(?:turn (?P<d>left|right) )?(?:fly )?heading (?P<v>(?:\w+ ?){3})$", b)
    if not m: return None
    return pick(rng, HDG_DIR).format(d=m.group("d"), v=m.group("v").strip()) if m.group("d") else pick(rng, HDG).format(v=m.group("v").strip())


SLOW = ["reduce speed {v}", "reduce speed to {v} knots", "reduce {v} knots", "slow to {v}", "slow down to {v}", "speed back to {v}", "bring the speed back to {v}",
        "reduce to {v} knots", "slow it down to {v}", "back to {v} knots", "come back to {v} knots", "speed {v}", "maintain {v} knots", "{v} knots",
        "give me {v} knots", "slow {v} knots", "ease back to {v} knots", "i need {v} knots slow down"]
FAST = ["increase speed {v}", "increase speed to {v} knots", "increase {v} knots", "speed up to {v}", "pick up the speed to {v}", "increase to {v} knots",
        "speed {v}", "maintain {v} knots", "{v} knots", "give me {v} knots", "push it up to {v} knots", "keep the speed up {v} knots", "faster please {v} knots"]


@kind("speed")
def _spd(b, rng):
    m = re.match(r"^(reduce|increase) speed(?: to)? (?P<v>.+?)(?: knots)?$", b)
    if not m: return None
    return pick(rng, SLOW if m.group(1) == "reduce" else FAST).format(v=m.group("v"))


CONTACT = ["contact {f} {fr}", "contact {f}", "{f} {fr}", "{f} on {fr}", "switch to {f} {fr}", "over to {f} {fr}", "call {f} on {fr}", "go to {f} {fr}",
           "talk to {f} {fr}", "change to {f} {fr}", "{f} now {fr}", "contact {f} now", "you can call {f} {fr}", "give {f} a call {fr}",
           "continue with {f} {fr}", "{f} is on {fr}", "contact {f} on {fr}", "switch over to {f}", "go to {f}"]
BYE = ["", "", "", " good day", " bye", " see you", " have a good one", " cheers", " good night"]


def freq(fr, rng):
    fr = re.sub(r"( zero)+$", "", fr) if rng.random() < 0.6 else fr
    r = rng.random()
    return fr.replace(" decimal ", " point ") if r < 0.25 else fr.replace(" decimal ", " ") if r < 0.38 else fr


@kind("contact")
def _contact(b, rng):
    m = re.match(r"^contact (?P<f>tower|ground|approach|departure|control|delivery|center|centre)(?: (?P<fr>.+))?$", b)
    if not m: return None
    t = pick(rng, CONTACT if m.group("fr") else [x for x in CONTACT if "{fr}" not in x])
    return re.sub(r"\s+", " ", t.format(f=m.group("f"), fr=freq(m.group("fr"), rng) if m.group("fr") else "")).strip() + pick(rng, BYE)


@kind("roger")
def _roger(b, rng):
    return pick(rng, ["roger", "roger that", "copy", "copy that", "copied", "understood", "okay", "okay understood", "got it", "okay thanks", "all right",
                      "alright roger", "noted", "okay copied", "roger thanks", "that's copied"]) if b == "roger" else None


@kind("standby")
def _standby(b, rng):
    return pick(rng, ["standby", "stand by", "stand by one", "hang on", "hang on a second", "wait one", "just a moment", "one moment", "give me a second",
                      "give me a minute", "hold on", "i'll call you back", "stand by i'll call you back", "bear with me", "wait", "stand by please"]) if b == "standby" else None


@kind("unable")
def _unable(b, rng):
    m = re.match(r"^unable (?P<r>traffic)(?: standby)?$", b)
    if not m: return None
    return pick(rng, ["unable traffic", "unable due traffic", "negative traffic", "not possible right now traffic", "can't do that traffic", "unable at the moment traffic",
                      "no can do traffic", "unable there's traffic", "negative due to traffic stand by", "unable for now traffic", "unable traffic stand by",
                      "sorry unable traffic", "can't approve that traffic"])


@kind("goAround")
def _ga(b, rng):
    if b != "go around i say again go around": return None
    return pick(rng, ["go around", "go around go around", "go around i say again go around", "abort the landing go around", "break off the approach go around",
                      "go around runway not clear", "go around traffic on the runway", "discontinue the approach go around", "pull up go around", "go around now",
                      "go around acknowledge", "you need to go around"])


@kind("holdPosition")
def _holdpos(b, rng):
    m = re.match(r"^hold position(?P<t> traffic)?$", b)
    if not m: return None
    s = pick(rng, ["hold position", "hold your position", "hold there", "stop there", "stop where you are", "hold it there", "stop hold position",
                   "stop taxi hold position", "hold right there", "stop", "hold position please", "just hold there"])
    return s + (pick(rng, [" traffic", " for traffic", " traffic crossing", " traffic ahead", " there's traffic"]) if m.group("t") else "")


@kind("continue")
def _cont(b, rng):
    return pick(rng, ["continue taxi", "continue", "continue taxiing", "carry on", "keep going", "you can continue", "keep taxiing", "resume taxi",
                      "okay continue", "carry on taxiing", "you can keep going", "continue your taxi"]) if b == "continue taxi" else None


@kind("expedite")
def _exp(b, rng):
    m = re.match(r"^expedite (descent|climb)$", b)
    if not m: return None
    d = m.group(1)
    return pick(rng, ["expedite descent", "expedite your descent", "expedite down", "descend faster", "increase your rate of descent", "best rate down",
                      "quicker descent please", "expedite the descent", "keep the descent coming expedite", "i need a faster descent"] if d == "descent" else
                ["expedite climb", "expedite your climb", "expedite up", "climb faster", "increase your rate of climb", "best rate up", "quicker climb please",
                 "expedite the climb", "keep the climb coming expedite", "i need a faster climb"])


@kind("direct")
def _direct(b, rng):
    m = re.match(r"^proceed direct (?P<v>.+)$", b)
    if not m: return None
    return pick(rng, ["direct {v}", "proceed direct {v}", "go direct {v}", "direct to {v}", "route direct {v}", "cleared direct {v}", "fly direct {v}",
                      "you can go direct {v}", "when ready direct {v}", "turn direct {v}", "straight to {v}", "direct {v} now", "own navigation direct {v}",
                      "proceed direct to {v}", "go direct to {v}"]).format(v=m.group("v"))


@kind("hold")
def _hold(b, rng):
    m = re.match(r"^hold at (?P<v>\w+) as published (?P<d>right|left) turns (?P<m>.+) legs$", b)
    if not m: return None
    return pick(rng, ["hold at {v} {d} turns {m} legs", "hold {v} {d} turns {m} legs", "enter the hold at {v} {d} hand turns {m} legs",
                      "hold at {v} as published {d} turns {m} legs", "take up the hold at {v} {d} turns {m} legs", "hold over {v} {d} turns {m} legs",
                      "holding at {v} {d} turns {m} legs", "i need you to hold at {v} {d} turns {m} legs"]).format(**m.groupdict())


@kind("ils")
def _ils(b, rng):
    m = re.match(r"^cleared ils approach runway (?P<v>.+?)(?P<r> report established)?$", b)
    if not m: return None
    s = pick(rng, ["cleared ils {v}", "cleared ils approach {v}", "cleared ils runway {v}", "cleared for the ils {v}", "cleared for the ils approach runway {v}",
                   "you're cleared ils {v}", "cleared approach ils {v}", "ils {v} cleared", "cleared the ils for {v}", "cleared ils approach runway {v}"]).format(v=m.group("v"))
    return s + (pick(rng, [" report established", " call established", " call me established", " report when established", " report established on the localizer"]) if m.group("r") else "")


@kind("expectRunway")
def _expect(b, rng):
    m = re.match(r"^expect ils approach runway (?P<v>.+?)(?: information (?P<i>\w+))?$", b)
    if not m: return None
    s = pick(rng, ["expect ils {v}", "expect ils approach runway {v}", "expect runway {v}", "expect the ils {v}", "you can expect ils {v}", "plan on the ils {v}",
                   "it'll be the ils {v}", "expect {v} ils", "expect vectors ils {v}", "vectors for the ils {v}", "it's going to be ils runway {v}",
                   "runway {v} for you expect the ils", "expect an ils approach runway {v}"]).format(v=m.group("v"))
    return s + (f" information {m.group('i')}" if m.group("i") and rng.random() < 0.4 else "")


@kind("radarContact")
def _radar(b, rng):
    m = re.match(r"^(?P<u>.+?) radar contact(?: qnh (?P<q>.+?))? expect ils approach runway (?P<v>.+)$", b)
    if not m: return None
    ts = ["radar contact expect ils {v}", "radar contact expect runway {v}", "identified expect ils {v}", "radar identified expect ils approach runway {v}",
          "i have you on radar expect the ils {v}", "you're identified expect runway {v}", "{u} radar contact expect ils {v}", "radar contact you can expect ils {v}",
          "radar contact plan on the ils {v}"] + (["radar contact qnh {q} expect ils {v}", "identified qnh {q} expect runway {v}"] if m.group("q") else [])
    return pick(rng, ts).format(**m.groupdict())


@kind("takeoff")
def _takeoff(b, rng):
    m = re.match(r"^wind (?P<w>.+?) runway (?P<v>.+?) cleared for takeoff$", b)
    if not m: return None
    return pick(rng, ["cleared for takeoff runway {v}", "runway {v} cleared for takeoff", "cleared for takeoff {v}", "you're cleared for takeoff runway {v}",
                      "cleared takeoff {v}", "runway {v} cleared takeoff", "cleared to take off runway {v}", "wind {w} runway {v} cleared for takeoff",
                      "runway {v} you are cleared for takeoff", "{v} cleared for takeoff wind {w}", "cleared for takeoff runway {v} wind {w}",
                      "runway {v} cleared for takeoff wind {w}"]).format(w=wind(m.group("w"), rng), v=m.group("v"))


def wind(w, rng):
    return re.sub(r" knots$", "", w.replace(" degrees ", " at ")) if rng.random() < 0.4 else w


@kind("clearedLand")
def _land(b, rng):
    m = re.match(r"^wind (?P<w>.+?) runway (?P<v>.+?) cleared to land$", b) or re.match(r"^runway (?P<v>.+?) cleared to land wind (?P<w>.+)$", b)
    if not m: return None
    return pick(rng, ["cleared to land runway {v}", "runway {v} cleared to land", "cleared to land {v}", "you're cleared to land runway {v}", "clear to land {v}",
                      "{v} cleared to land", "cleared to land {v} wind {w}", "land runway {v}", "runway {v} you are cleared to land", "cleared land {v}",
                      "wind {w} cleared to land {v}", "runway {v} cleared to land wind {w}"]).format(w=wind(m.group("w"), rng), v=m.group("v"))


@kind("cross")
def _cross(b, rng):
    m = re.match(r"^cross runway (?P<v>.+?)(?: report vacated)?$", b)
    if not m: return None
    return pick(rng, ["cross runway {v}", "cross {v}", "you can cross runway {v}", "cleared to cross runway {v}", "cross {v} now", "go ahead and cross {v}",
                      "cross runway {v} report vacated", "cross {v} report vacated", "cross runway {v} tell me when you're clear", "okay to cross {v}",
                      "cross over runway {v}", "runway {v} cross", "cross runway {v} call me when vacated"]).format(v=m.group("v"))


@kind("holdShort")
def _hs(b, rng):
    m = re.match(r"^hold short of runway (?P<v>.+)$", b)
    if not m: return None
    return pick(rng, ["hold short of runway {v}", "hold short {v}", "hold short of {v}", "hold short runway {v}", "stop before runway {v} hold short",
                      "do not cross runway {v} hold short", "short of {v} hold", "hold short of runway {v} please", "you need to hold short of {v}",
                      "hold short at runway {v}", "hold short of runway {v} for now"]).format(v=m.group("v"))


@kind("pushback")
def _push(b, rng):
    m = re.match(r"^(?P<su>start up and )?pushback approved expect runway (?P<v>.+)$", b)
    if not m: return None
    ts = ["start up and pushback approved expect runway {v}", "push and start approved expect runway {v}", "start and push approved expect {v}",
          "pushback and start up approved expect runway {v}", "you're cleared to push and start expect {v}", "push and start at your discretion expect runway {v}",
          "cleared push and start expect runway {v}"] if m.group("su") else \
         ["pushback approved expect runway {v}", "push approved expect {v}", "you can push back expect runway {v}", "pushback is approved expect {v}",
          "push back approved expect runway {v}", "cleared to push expect runway {v}", "okay to push expect {v}", "push when ready expect runway {v}"]
    return pick(rng, ts).format(v=m.group("v"))


@kind("startup")
def _start(b, rng):
    m = re.match(r"^start up approved expect runway (?P<v>.+?)(?: qnh (?P<q>.+))?$", b)
    if not m: return None
    s = pick(rng, ["start up approved expect runway {v}", "start approved expect {v}", "startup approved expect runway {v}", "you're good to start expect runway {v}",
                   "cleared to start expect {v}", "start up is approved expect runway {v}", "engine start approved expect runway {v}",
                   "start at your discretion expect runway {v}", "okay to start expect {v}"]).format(v=m.group("v"))
    return s + (f" qnh {m.group('q')}" if m.group("q") and rng.random() < 0.4 else "")


@kind("taxi")
def _taxi(b, rng):
    s = b
    if s.startswith("taxi to holding point runway "):
        s = pick(rng, ["taxi to runway ", "taxi runway ", "taxi to holding point ", "taxi holding point runway ", "taxi out to runway ", "taxi to holding point runway ",
                       "you can taxi to runway ", "taxi to the holding point runway "]) + s[len("taxi to holding point runway "):]
    elif s.startswith("taxi to stand "):
        s = pick(rng, ["taxi to stand ", "taxi stand ", "taxi in to stand ", "taxi to your stand ", "you can taxi to stand "]) + s[len("taxi to stand "):]
    else:
        return None
    s = s.replace(" hold short of runway ", pick(rng, [" hold short of runway ", " hold short of ", " hold short runway ", " hold short ", " and hold short of runway "]))
    s = s.replace(" via ", pick(rng, [" via ", " via ", " using ", " via taxiway "]))
    return s


@kind("exitAt")
def _exit(b, rng):
    m = re.match(r"^vacate via (?P<v>.+)$", b)
    if not m: return None
    return pick(rng, ["vacate via {v}", "vacate {v}", "exit {v}", "exit via {v}", "take {v} to vacate", "vacate at {v}", "turn off at {v}", "take the exit at {v}",
                      "leave the runway via {v}", "exit at {v}"]).format(v=m.group("v"))


@kind("windCheck")
def _wind(b, rng):
    m = re.match(r"^wind (?P<w>.+)$", b)
    if not m: return None
    return pick(rng, ["wind {w}", "wind is {w}", "the wind is {w}", "surface wind {w}", "wind check {w}", "current wind {w}", "winds {w}"]).format(w=wind(m.group("w"), rng))


@kind("cancelTakeoff")
def _rto(b, rng):
    if not b.startswith("stop immediately"): return None
    return pick(rng, ["stop immediately", "stop immediately i say again stop immediately", "cancel takeoff", "cancel takeoff i say again cancel takeoff", "abort takeoff",
                      "stop stop stop", "reject takeoff stop immediately", "cancel takeoff clearance", "hold position cancel takeoff", "stop immediately cancel takeoff"])


CHAT = ["how's the ride at your level", "are you ready to push", "do you have the field in sight", "what's your fuel state", "thanks for your help today",
        "did you copy the weather", "how many passengers today", "where are you coming from", "nice landing", "welcome to the frequency", "good morning",
        "good evening how are you", "are you with me", "what type are you", "is that you on the taxiway", "sorry about the delay", "we're a bit busy today",
        "happy holidays", "do you need anything", "can you see the traffic ahead", "what's your gate tonight", "how long have you been waiting", "never mind",
        "testing testing", "who called", "is anyone on frequency", "sorry wrong aircraft", "what a beautiful day", "did you get the atis", "is your gear down",
        "how's the weather up there", "say hello to the crew", "are you the one who called", "any chance of a shortcut later", "enjoy your flight",
        "what's it like out there", "long day today", "do you speak french", "is the captain flying today", "see you next time", "have you been here before",
        "you there", "hello", "uh", "um where was i", "what was i saying", "nice to hear you again", "was that you", "how was the approach"]


def callsign_words(head):
    return " ".join(ICAO_TO_STT.get(w, w) for w in stt_normalise(head).split())


def plain(rec, rng):
    """(said, line) for one record in plain wording, or None when the kind has no everyday form here."""
    f = T.get(rec["kind"])
    if not f: return None
    phrase = rec["say"].get("ICAO") or rec["say"].get("FAA")
    head, _, rest = phrase.partition(",")
    body = " ".join(ICAO_TO_STT.get(w, w) for w in stt_normalise(rest).split())
    out = f(body, rng)
    if not out: return None
    cs = callsign_words(head)
    r = rng.random()
    if r < 0.06: out = pick(rng, ["uh ", "and ", "okay ", "yeah "]) + out
    if rng.random() < 0.07 and not out.endswith(("please", "day", "bye", "you", "one", "cheers", "night", "thanks")): out += pick(rng, [" please", " thanks", " thank you"])
    said = f"{out} {cs}" if rng.random() < 0.1 else f"{cs} {out}"
    return re.sub(r"\s+", " ", said.replace("'", "")).strip()


def chat(rec, rng):
    head = rec["say"].get("ICAO", "").partition(",")[0]
    c = pick(rng, CHAT).replace("'", "")
    return f"{callsign_words(head)} {c}" if rng.random() < 0.7 else c


def skeleton(s):
    """A line with its values masked, to compare wordings."""
    num = r"(?:zero|one|two|three|four|five|six|seven|eight|nine|niner|tree|fife|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|decimal|point|left|right|center|centre|\d+)"
    return re.sub(rf"(?:{num} ?)+", "# ", s).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+"); ap.add_argument("--out", default="ml/data/out5/ds")
    ap.add_argument("--holdout", default="YSSY"); ap.add_argument("--val-seed", type=int, default=4); ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--chat", type=float, default=0.08); ap.add_argument("--max-heading", type=float, default=0.45, help="keep this share of heading records (they dominate)")
    ap.add_argument("--leak", default="ml/s1/freeword/held.json")
    a = ap.parse_args()
    rng = random.Random(a.seed)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    files = {k: open(out / f"{k}_plain.jsonl", "w") for k in ("train", "val", "test_airport")}
    counts = {k: 0 for k in files}; kinds = {}; skel = set()
    for path in a.inputs:
        for line in open(path):
            rec = json.loads(line)
            split = "test_airport" if rec["icao"] == a.holdout else "val" if rec["seed"] == a.val_seed else "train"
            if rec["kind"] == "heading" and rng.random() > a.max_heading: continue
            said = plain(rec, rng)
            if said:
                files[split].write(json.dumps({"ctx": rec["ctx"], "said": said, "line": rec["line"], "kind": rec["kind"], "src": "plain", "icao": rec["icao"]}) + "\n")
                counts[split] += 1; kinds[rec["kind"]] = kinds.get(rec["kind"], 0) + 1
                if split == "train": skel.add(skeleton(said.split(" ", 3)[-1]))
            if rng.random() < a.chat:
                files[split].write(json.dumps({"ctx": rec["ctx"], "said": chat(rec, rng), "line": "SAY AGAIN", "kind": "sayAgain", "src": "chat", "icao": rec["icao"]}) + "\n")
                counts[split] += 1
    for f in files.values(): f.close()
    print(json.dumps(counts)); print(json.dumps(dict(sorted(kinds.items(), key=lambda kv: -kv[1]))))
    if a.leak and Path(a.leak).exists():   # how much of the exam would a template reproduce word for word?
        body = lambda t: skeleton(t).partition("# ")[2] or skeleton(t)   # the wording after the callsign, whatever the airline
        train_bodies = set()
        for l in open(out / "train_plain.jsonl"):
            train_bodies.add(body(json.loads(l)["said"]))
        held = json.loads(Path(a.leak).read_text())
        same = [h["key"] for h in held if body(h["heard"].replace("'", "")) in train_bodies]
        print(f"exam lines whose wording (values masked) also occurs in training: {len(same)} of {len(held)}")
        json.dump(same, open(out / "leak.json", "w"), indent=1)


if __name__ == "__main__":
    main()
