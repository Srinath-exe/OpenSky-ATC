"""Coverage-driven controller lines for the speech-to-text fine-tune, round 2: ml/data/stt/synth2/lines.jsonl.
    ml/stt/.venv/bin/python ml/stt/data/coverage_lines.py [--seed 11]

ATC speech is patterns x blanks, so lines are picked by quota, not at random (round 1 sampled 12,000 at random):
  pool     the exporter's phrasings (ml/data/out*/), up to PER_SKELETON per phrase shape (numbers and callsign masked):
           every shape the game's phraseology can produce is spoken several times
  swap     pool lines with the airline replaced: every telephony callsign of ml/data/stt/lists/callsigns.txt
           (OpenFlights, active airlines) PER_CALLSIGN times, plus general-aviation registrations, with every number style
  grammar  phraseology the game's engine does not word (ICAO Doc 4444 / FAA 7110.65 style: traffic information, squawk,
           conditional clearances, visual approaches, wake turbulence, ATIS, readback corrections, plain-language requests),
           PER_TEMPLATE fills each, tagged with the position that says it (DEL / GND / TWR / APP / CTR)
Never used: Sydney (the unseen test airport), the owner's gold lines, any text of round 1. Fix names are written
capitalised ("Boswe") so a voice reads them as a word, never as letters; `text` is textnorm.norm(say)."""
import argparse, collections, glob, json, random, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).parent))
from textnorm import norm

PER_SKELETON, PER_CALLSIGN, PER_TEMPLATE = 4, 6, 70
ENGINES = {"phonon": 0.56, "kokoro": 0.16, "supertonic": 0.14, "paradee": 0.14}
PH = "alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split()
D_PLAIN = "zero one two three four five six seven eight nine".split()
D_ICAO = "zero one two tree four fife six seven eight niner".split()
TEENS = "ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split()
CITIES = ("London Heathrow Gatwick Paris Frankfurt Munich Zurich Geneva Vienna Prague Amsterdam Brussels Madrid Barcelona Lisbon Rome Milan Athens "
          "Istanbul Dubai Doha Mumbai Delhi Bangkok Singapore Jakarta Manila Tokyo Osaka Seoul Beijing Shanghai Sydney Melbourne Brisbane Auckland "
          "Boston Kennedy Newark Washington Atlanta Miami Chicago Dallas Houston Denver Seattle Oakland Norcal Socal Toronto Montreal Vancouver "
          "Mexico Bogota Lima Santiago Shannon Scottish Maastricht Rhein Langen Reims Marseille Bordeaux Swanwick").split()
TYPES = ("Boeing seven three seven|Boeing seven four seven|Boeing triple seven|Boeing seven eight seven|Airbus three twenty|Airbus three fifty|"
         "Airbus three eighty|Airbus three thirty|Embraer one ninety|Dash eight|ATR seventy two|Cessna one seventy two|Citation|Gulfstream|"
         "Learjet|King Air|helicopter|CRJ nine hundred|MD eleven|heavy Boeing seven four seven").split("|")
MADE_FIXES = ("Lambourne Bovingdon Ockham Biggin Detling Dover Midhurst Clacton Brookmans Compton Pole Hill Trent Wallasey Daventry Honiley "
              "Robbinsville Sparta Deer Park Calverton Bridgeport Carmel Kingston Sea Isle Coyle Modesto Sausalito Woodside Point Reyes "
              "Seal Beach Ventura Fillmore Lake Hughes Daggett Hector Paradise").split()


def digits(rnd, s: str, icao: bool) -> str:
    return " ".join((D_ICAO if icao else D_PLAIN)[int(c)] for c in s)


def grouped(n: int) -> str:
    """FAA group form of 10..99: 'twenty two', 'fifteen', 'forty'."""
    if n < 10: return D_PLAIN[n]
    if n < 20: return TEENS[n - 10]
    return TENS[n // 10 - 2] + ("" if n % 10 == 0 else " " + D_PLAIN[n % 10])


class Fill:
    def __init__(self, rnd, fixes, callsigns):
        self.r, self.fixes, self.callsigns = rnd, fixes, callsigns

    def icao(self): return self.r.random() < 0.55
    def d(self, s): return digits(self.r, s, self.icao())

    def flight(self):
        r = self.r; n = r.choice([1, 2, 2, 3, 3, 3, 4, 4]); s = str(r.randint(1, 9)) + "".join(str(r.randint(0, 9)) for _ in range(n - 1))
        style = r.random()
        if style < 0.55 or n == 1: out = self.d(s)
        elif n == 2: out = grouped(int(s))
        elif n == 3: out = f"{D_PLAIN[int(s[0])]} {grouped(int(s[1:])) if s[1] != '0' else 'zero ' + D_PLAIN[int(s[2])]}"
        else: out = f"{grouped(int(s[:2]))} {grouped(int(s[2:])) if s[2] != '0' else 'zero ' + D_PLAIN[int(s[3])]}"
        if r.random() < 0.12: out += " " + r.choice(PH)
        if r.random() < 0.06: out += " " + r.choice(PH)
        return out

    def cs(self):
        r = self.r; k = r.random()
        if k < 0.08:   # general aviation / registration
            pre = r.choice(["November", "Golf", "Delta", "Hotel Bravo", "Oscar Kilo", "Victor Tango", "Foxtrot", "Charlie", "Cessna", "Cirrus", "Skyhawk", "Citation"])
            body = " ".join([self.d(str(r.randint(1, 999)))] + r.sample(PH, r.randint(1, 2))) if r.random() < 0.6 else " ".join(r.sample(PH, r.randint(3, 4)))
            return f"{pre} {body}"
        name = r.choice(self.callsigns).title()
        out = f"{name} {self.flight()}"
        if r.random() < 0.06: out += r.choice([" heavy", " super"])
        return out

    def rwy(self):
        r = self.r; n = r.randint(1, 36); side = r.choice(["", "", " left", " right", " left", " right", " centre", " center"])
        return f"{self.d(f'{n:02d}')}{side}"

    def hdg(self): return self.d(f"{self.r.randrange(5, 365, 5) % 360 or 360:03d}")
    def spd(self): return self.d(str(self.r.choice([160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 290, 300, 310, 320])))
    def mach(self): return f"mach {self.r.choice(['decimal', 'point'])} {self.d(str(self.r.randint(70, 86)))}"

    def alt(self):
        r = self.r; a = r.choice([1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000])
        th, hu = divmod(a, 1000)
        t = (self.d(str(th)) if th < 10 or r.random() < 0.7 else grouped(th)) + " thousand"
        if hu: t += f" {self.d(str(hu // 100))} hundred"
        return t + (" feet" if r.random() < 0.25 else "")

    def fl(self):
        n = self.r.choice(list(range(60, 200, 10)) + list(range(200, 420, 10)))
        return "flight level " + ("one hundred" if n == 100 and self.r.random() < 0.5 else "two hundred" if n == 200 and self.r.random() < 0.3 else self.d(str(n)))

    def level(self): return self.fl() if self.r.random() < 0.5 else self.alt()

    def freq(self):
        r = self.r; a = r.randint(118, 136); b = r.choice(["0", "5", "05", "25", "45", "65", "7", "75", "9", "125", "275", "305", "425", "505", "705", "905"])
        return f"{self.d(str(a))} {r.choice(['decimal', 'decimal', 'point'])} {self.d(b)}"

    def qnh(self): return self.d(str(self.r.randint(980, 1035)))
    def altim(self): return self.d(str(self.r.randint(2890, 3060)))
    def sqk(self): return self.d("".join(str(self.r.randint(0, 7)) for _ in range(4)))
    def twy(self): return self.r.choice(PH).title() + (f" {self.d(str(self.r.randint(1, 12)))}" if self.r.random() < 0.35 else "")
    def twys(self): return ", ".join(self.twy() for _ in range(self.r.randint(1, 4)))
    def stand(self): return self.r.choice([self.d(str(self.r.randint(1, 340))), f"{self.r.choice(PH).title()} {self.d(str(self.r.randint(1, 60)))}"])
    def gate(self): return self.stand()

    def fix(self):
        r = self.r; k = r.random()
        if k < 0.6: return r.choice(self.fixes).capitalize()
        if k < 0.8: return r.choice(MADE_FIXES)
        return " ".join(w.title() for w in r.sample(PH, 3))   # a VOR spelled out

    def city(self): return self.r.choice(CITIES)
    def unit(self): return self.r.choice(["Tower", "Ground", "Approach", "Departure", "Control", "Radar", "Director", "Delivery", "Center", "Apron", "Arrival", "Radio", "Information"])
    def facility(self): return (self.city() + " " if self.r.random() < 0.5 else "") + self.unit()
    def atis(self): return self.r.choice(PH).title()
    def wind(self):
        r = self.r
        if r.random() < 0.1: return "wind calm"
        w = f"wind {self.d(f'{r.randrange(10, 370, 10):03d}')} {r.choice(['degrees ', 'at ', 'degrees ', ''])}{self.d(str(r.randint(3, 28)))}{r.choice([' knots', ' knots', ''])}"
        return w + (f" gusting {self.d(str(r.randint(18, 40)))}" if r.random() < 0.2 else "")
    def clock(self): return self.r.choice(["one", "two", "three", "ten", "eleven", "twelve", "nine", "one", "two", "twelve"]) + " o'clock"
    def miles(self): return self.r.choice([self.d(str(self.r.randint(2, 25))), grouped(self.r.randint(2, 25))]) + " miles"
    def actype(self): return self.r.choice(TYPES)
    def dir(self): return self.r.choice(["left", "right"])
    def card(self): return self.r.choice(["north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"])
    def num(self): return self.d(str(self.r.randint(1, 9)))
    def minutes(self): return self.d(str(self.r.choice([1, 2, 3, 5, 10, 15, 20, 30])))
    def rate(self): return self.d(str(self.r.choice([1000, 1500, 2000, 2500, 3000])))
    def star(self): return f"{self.fix()} {self.d(str(self.r.randint(1, 9)))} {self.r.choice(PH).title()}"
    def time(self): return self.d(f"{self.r.randint(0, 59):02d}")
    def dme(self): return self.d(str(self.r.randint(2, 40)))


# position, template. One line per template; {slot} = a Fill method. Phrasing follows ICAO Doc 4444 / FAA 7110.65.
T = """
DEL|{cs}, cleared to {city} via the {star} departure, flight planned route, climb initially {level}, squawk {sqk}.
DEL|{cs}, cleared to {city} as filed, maintain {alt}, expect {fl} one zero minutes after departure, departure frequency {freq}, squawk {sqk}.
DEL|{cs}, readback correct, contact {facility} {freq} when ready for push.
DEL|{cs}, start-up approved, QNH {qnh}, information {atis} is current.
DEL|{cs}, expect start-up in {minutes} minutes.
DEL|{cs}, stand by for clearance.
DEL|{cs}, clearance on request.
DEL|{cs}, squawk {sqk}.
DEL|{cs}, confirm you have information {atis}.
DEL|{cs}, negative, hold for release, expect departure at time {time}.
GND|{cs}, pushback and start-up approved, facing {card}.
GND|{cs}, push approved, tail {card}.
GND|{cs}, pushback approved, expect runway {rwy}.
GND|{cs}, hold position, traffic pushing back behind.
GND|{cs}, taxi to holding point runway {rwy} via {twys}.
GND|{cs}, taxi to holding point {twy}, runway {rwy}, QNH {qnh}.
GND|{cs}, runway {rwy}, taxi via {twys}, hold short of runway {rwy}.
GND|{cs}, taxi to stand {stand} via {twys}.
GND|{cs}, taxi to gate {gate} via {twys}.
GND|{cs}, continue via {twys}, hold short of {twy}.
GND|{cs}, hold short of runway {rwy}.
GND|{cs}, hold short of taxiway {twy}.
GND|{cs}, cross runway {rwy}, report vacated.
GND|{cs}, cross runway {rwy} at {twy}, then contact {facility} {freq}.
GND|{cs}, give way to the {actype} passing {dir} to {dir}.
GND|{cs}, follow the {actype} ahead.
GND|{cs}, hold position.
GND|{cs}, continue taxi.
GND|{cs}, expedite taxi, traffic on final.
GND|{cs}, taxi straight ahead, {dir} at {twy}.
GND|{cs}, turn {dir} on {twy}, then {dir} on {twy}.
GND|{cs}, backtrack runway {rwy}.
GND|{cs}, vacate {dir} via {twy}.
GND|{cs}, vacate at the end, contact ground {freq}.
GND|{cs}, contact tower {freq}.
GND|{cs}, monitor tower {freq}.
GND|{cs}, taxi to the de-icing pad via {twys}.
GND|{cs}, progressive taxi, turn {dir} next taxiway.
GND|{cs}, stop immediately, I say again, stop immediately.
GND|{cs}, say stand number.
GND|{cs}, report ready for departure.
TWR|{cs}, line up and wait runway {rwy}.
TWR|{cs}, runway {rwy}, line up and wait, traffic crossing downfield.
TWR|{cs}, behind the landing {actype}, line up runway {rwy} behind.
TWR|{cs}, {wind}, runway {rwy}, cleared for takeoff.
TWR|{cs}, runway {rwy}, cleared for takeoff, {wind}.
TWR|{cs}, fly runway heading, runway {rwy}, cleared for takeoff.
TWR|{cs}, after departure turn {dir} heading {hdg}, runway {rwy}, cleared for takeoff.
TWR|{cs}, cleared for immediate takeoff runway {rwy}.
TWR|{cs}, cancel takeoff clearance, hold position, I say again, cancel takeoff.
TWR|{cs}, stop immediately, {cs}, stop immediately.
TWR|{cs}, hold short runway {rwy}, landing traffic.
TWR|{cs}, {wind}, runway {rwy}, cleared to land.
TWR|{cs}, runway {rwy}, cleared to land, {wind}.
TWR|{cs}, continue approach runway {rwy}, number {num}.
TWR|{cs}, continue approach, traffic to depart.
TWR|{cs}, number {num}, follow the {actype} on {miles} final.
TWR|{cs}, go around, I say again, go around.
TWR|{cs}, go around, fly runway heading, climb to {alt}.
TWR|{cs}, cleared touch and go runway {rwy}.
TWR|{cs}, cleared low approach runway {rwy}.
TWR|{cs}, cleared for the option runway {rwy}.
TWR|{cs}, make {dir} three sixty for spacing.
TWR|{cs}, extend downwind, I'll call your base.
TWR|{cs}, report {dir} base runway {rwy}.
TWR|{cs}, report final runway {rwy}.
TWR|{cs}, enter {dir} downwind runway {rwy}.
TWR|{cs}, caution wake turbulence, departing {actype}.
TWR|{cs}, {wind}.
TWR|{cs}, wind check {wind}.
TWR|{cs}, vacate {dir}, contact ground {freq}.
TWR|{cs}, expedite vacating, traffic on short final.
TWR|{cs}, contact departure {freq}.
TWR|{cs}, contact {facility} {freq}, good day.
TWR|{cs}, airborne time {time}, contact {facility} {freq}.
TWR|{cs}, traffic, {actype} on {miles} final runway {rwy}.
TWR|{cs}, runway {rwy} is wet, braking action reported medium.
TWR|{cs}, landing gear appears down.
APP|{cs}, radar contact, climb to {level}.
APP|{cs}, identified, descend to {level}, QNH {qnh}.
APP|{cs}, {facility}, radar contact, expect ILS approach runway {rwy}, information {atis}.
APP|{cs}, descend and maintain {alt}, altimeter {altim}.
APP|{cs}, climb and maintain {alt}.
APP|{cs}, descend to {alt}, QNH {qnh}.
APP|{cs}, climb to {fl}.
APP|{cs}, descend to {fl}, be level by {fix}.
APP|{cs}, expedite descent through {level}.
APP|{cs}, expedite climb until passing {level}.
APP|{cs}, stop climb at {level}.
APP|{cs}, maintain {level}.
APP|{cs}, descend at {rate} feet per minute or greater.
APP|{cs}, turn {dir} heading {hdg}.
APP|{cs}, fly heading {hdg}.
APP|{cs}, turn {dir} heading {hdg}, descend to {alt}.
APP|{cs}, continue present heading.
APP|{cs}, turn {dir} {num} zero degrees.
APP|{cs}, turn {dir} heading {hdg}, vectors for spacing.
APP|{cs}, reduce speed to {spd} knots.
APP|{cs}, increase speed to {spd} knots.
APP|{cs}, maintain {spd} knots or greater.
APP|{cs}, maintain {spd} knots until {dme} DME.
APP|{cs}, speed {spd} knots until {num} miles final.
APP|{cs}, reduce to minimum clean speed.
APP|{cs}, no speed restrictions.
APP|{cs}, resume normal speed.
APP|{cs}, maintain {mach}.
APP|{cs}, proceed direct {fix}.
APP|{cs}, direct {fix}, then {fix}.
APP|{cs}, resume own navigation direct {fix}.
APP|{cs}, hold at {fix} as published, expect further clearance at time {time}.
APP|{cs}, hold at {fix}, {dir} turns, {num} minute legs, maintain {level}.
APP|{cs}, cleared {star} arrival, descend to {level}.
APP|{cs}, descend via the {star} arrival.
APP|{cs}, turn {dir} heading {hdg}, cleared ILS approach runway {rwy}, report established.
APP|{cs}, cleared ILS approach runway {rwy}.
APP|{cs}, {miles} from {fix}, turn {dir} heading {hdg}, maintain {alt} until established on the localizer, cleared ILS runway {rwy} approach.
APP|{cs}, intercept the localizer runway {rwy}.
APP|{cs}, cleared RNAV approach runway {rwy}.
APP|{cs}, cleared visual approach runway {rwy}.
APP|{cs}, cleared VOR approach runway {rwy}.
APP|{cs}, report the field in sight.
APP|{cs}, report established on the localizer.
APP|{cs}, expect vectors for ILS approach runway {rwy}.
APP|{cs}, expect runway {rwy}.
APP|{cs}, cancel approach clearance, turn {dir} heading {hdg}, climb to {alt}.
APP|{cs}, {miles} from touchdown, contact tower {freq}.
APP|{cs}, contact tower {freq}.
APP|{cs}, contact {facility} {freq}.
APP|{cs}, traffic, {clock}, {miles}, opposite direction, {actype}, {alt}.
APP|{cs}, traffic {clock}, {miles}, crossing {dir} to {dir}, {num} thousand feet above.
APP|{cs}, traffic no longer a factor.
APP|{cs}, squawk {sqk}.
APP|{cs}, squawk ident.
APP|{cs}, squawk mayday, seven seven zero zero.
APP|{cs}, confirm squawk {sqk}.
APP|{cs}, say altitude.
APP|{cs}, say heading.
APP|{cs}, say indicated airspeed.
APP|{cs}, report passing {level}.
APP|{cs}, report reaching {level}.
APP|{cs}, roger mayday, turn {dir} heading {hdg}, descend to {alt}.
APP|{cs}, roger pan pan, say intentions.
APP|{cs}, say fuel remaining and souls on board.
APP|{cs}, caution wake turbulence, you are {miles} behind a heavy {actype}.
APP|{cs}, QNH {qnh}.
APP|{cs}, altimeter {altim}.
CTR|{cs}, {facility}, identified.
CTR|{cs}, climb {fl}.
CTR|{cs}, descend {fl}.
CTR|{cs}, climb to {fl}, cross {fix} at or above {fl}.
CTR|{cs}, when ready descend to {fl}.
CTR|{cs}, descend now {fl}, traffic.
CTR|{cs}, cleared direct {fix}.
CTR|{cs}, route direct {fix}, {fix}.
CTR|{cs}, turn {dir} {num} zero degrees for traffic.
CTR|{cs}, maintain {mach} or greater.
CTR|{cs}, contact {facility} {freq}, good day.
CTR|{cs}, contact {city} {freq}.
CTR|{cs}, squawk {sqk} and ident.
CTR|{cs}, radar service terminated, squawk seven thousand, frequency change approved.
CTR|{cs}, say mach number.
CTR|{cs}, report your level.
CTR|{cs}, confirm {fl}.
CTR|{cs}, expect holding at {fix}, delay {minutes} minutes.
ANY|{cs}, roger.
ANY|{cs}, stand by.
ANY|{cs}, say again.
ANY|{cs}, say again all after {fix}.
ANY|{cs}, negative, I say again, maintain {level}.
ANY|{cs}, correction, turn {dir} heading {hdg}.
ANY|{cs}, affirm.
ANY|{cs}, negative.
ANY|{cs}, unable, traffic, standby.
ANY|{cs}, unable due traffic, expect {level} in {minutes} minutes.
ANY|{cs}, readback correct.
ANY|{cs}, confirm heading {hdg}.
ANY|{cs}, disregard.
ANY|{cs}, how do you read.
ANY|{cs}, read you five.
ANY|{cs}, break break, {cs}, turn {dir} heading {hdg}.
ANY|{cs}, hand off to {unit} {freq}.
ANY|{cs}, switch to {unit} on {freq}.
ANY|{cs}, go ahead.
ANY|{cs}, pass your message.
ANY|{cs}, good morning, {facility}.
ANY|{cs}, thank you, good day.
ANY|all stations, {facility}, QNH now {qnh}.
ANY|all stations, information {atis} is now current.
ANY|station calling {facility}, say again your callsign.
"""
TEMPLATES = [tuple(l.split("|", 1)) for l in T.strip().split("\n")]
NUMW = r"\b(zero|one|two|three|tree|four|fower|five|fife|six|seven|eight|nine|niner|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|decimal|point)\b"
POS = {"ground": "GND", "tower": "TWR", "approach": "APP"}


def speakable(say: str) -> str:
    """All-caps fix names as words: BOSWE -> Boswe (3-letter beacons too: the game reads BIG as a word)."""
    keep = {"ILS", "QNH", "VOR", "DME", "RNAV", "ATIS", "KLM", "UPS", "IFR", "VFR", "CRJ", "ATR", "MD"}
    return re.sub(r"\b[A-Z]{3,6}\b", lambda m: m.group() if m.group() in keep else m.group().capitalize(), say)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--out", default=str(ROOT / "ml/data/stt/synth2/lines.jsonl")); a = ap.parse_args()
    rnd = random.Random(a.seed)
    banned = {norm(p["said"]) for p in json.load(open(ROOT / "public/voice/gold-prompts.json"))["prompts"] if p.get("said")}
    old = ROOT / "ml/data/stt/synth/lines.jsonl"
    if old.exists(): banned |= {json.loads(l)["text"] for l in open(old)}
    callsigns = [l.strip() for l in open(ROOT / "ml/data/stt/lists/callsigns.txt") if l.strip()]
    pool = []
    for f in sorted(glob.glob(str(ROOT / "ml/data/out[0-9]*/*.jsonl"))):
        for l in open(f):
            r = json.loads(l)
            if "say" in r and r["icao"] != "YSSY": pool.append(r)
    rnd.shuffle(pool)
    fixes = sorted({m for r in pool for m in re.findall(r"\b[A-Z]{5}\b", " ".join(r["say"].values()))})
    fixes = [f for f in fixes if re.search("[AEIOU]", f[:2]) and not re.search("[^AEIOU]{4}", f)] or fixes   # ones a voice can read as a word
    out, seen = [], set(banned)

    def add(say, src, pos, tag, extra=None):
        say = speakable(say); t = norm(say)
        if not t or t in seen or len(t.split()) > 45: return False
        seen.add(t); out.append({"say": say, "text": t, "src": src, "pos": pos, "tag": tag, **(extra or {})}); return True

    # 1. pool: every phrase shape of the game's phraseology
    per = collections.Counter(); airline = lambda r: r["name"].rsplit(" ", 1)[0]
    def skeleton(r, s):
        t = s.lower().replace("-", " ")
        if not r["name"][-1].isalpha() or " " in r["name"]: t = t.replace(airline(r).lower(), "CS", 1)
        t = re.sub(NUMW, "#", t); return re.sub(r"(# ?)+", "# ", t)
    swappable = []
    for r in pool:
        for style, s in r["say"].items():
            k = skeleton(r, s)
            if per[k] >= PER_SKELETON: continue
            if add(s, "pool", POS.get(r.get("pos"), "ANY"), k[:60], {"line": r["line"], "kind": r["kind"], "icao": r["icao"], "ctx": r["ctx"], "style": style}): per[k] += 1
        if s.lower().startswith(airline(r).lower() + " ") and " " in r["name"]: swappable.append(r)
    n_pool = len(out)
    # 2. swap: every airline telephony + general aviation, on the game's phrasings
    F = Fill(rnd, fixes, callsigns); k = 0
    for name in callsigns:
        got = 0
        while got < PER_CALLSIGN and k < len(swappable) * 3:
            r = swappable[k % len(swappable)]; k += 1
            s = rnd.choice(list(r["say"].values())); body = s.split(",", 1)
            if len(body) < 2: continue
            cs = f"{name.title()} {F.flight()}"
            got += add(f"{cs},{body[1]}", "swap", POS.get(r.get("pos"), "ANY"), "cs:" + name)
    GA = Fill(rnd, fixes, callsigns)
    for _ in range(6000):
        if sum(1 for r in out if r["tag"] == "cs:ga") >= 900: break
        r = rnd.choice(swappable); body = rnd.choice(list(r["say"].values())).split(",", 1)
        pre = rnd.choice(["November", "Golf", "Delta", "Hotel Bravo", "Oscar Kilo", "Victor Tango", "Foxtrot", "Charlie", "Cessna", "Cirrus", "Skyhawk", "Citation"])
        reg = " ".join([GA.d(str(rnd.randint(1, 999)))] + rnd.sample(PH, rnd.randint(1, 2))) if rnd.random() < 0.6 else " ".join(rnd.sample(PH, rnd.randint(3, 4)))
        if len(body) == 2: add(f"{pre} {reg},{body[1]}", "swap", POS.get(r.get("pos"), "ANY"), "cs:ga")
    n_swap = len(out) - n_pool
    # 3. grammar: phraseology beyond the game's engine
    for pos, tpl in TEMPLATES:
        got = tries = 0
        while got < PER_TEMPLATE and tries < PER_TEMPLATE * 6:
            tries += 1
            got += add(re.sub(r"\{(\w+)\}", lambda m: getattr(F, m.group(1))(), tpl), "grammar", pos, tpl[:60])
    n_gr = len(out) - n_pool - n_swap
    # engines and voices
    sys.path.insert(0, str(Path(__file__).parent)); from make_lines import voices
    V = voices(); rnd.shuffle(out)
    eng = [e for e, share in ENGINES.items() for _ in range(round(share * len(out)))]; eng = (eng + ["phonon"] * len(out))[: len(out)]; rnd.shuffle(eng)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    with open(a.out, "w") as fo:
        for i, (r, e) in enumerate(zip(out, eng)):
            main_v, acc = V[e]
            v = rnd.choice(acc) if acc and rnd.random() < 0.4 else rnd.choice(main_v)
            speed = round(rnd.uniform(0.95, 1.3), 2) if e in ("kokoro", "paradee") else 1.0
            fo.write(json.dumps({"id": f"t{i:05d}", "engine": e, "voice": v, "speed": speed, **r}) + "\n")
    words = collections.Counter(w for r in out for w in r["text"].split())
    print(f"{len(out)} lines: pool {n_pool} ({len(per)} shapes), swap {n_swap} ({len(callsigns)} airlines), grammar {n_gr} ({len(TEMPLATES)} templates)")
    print("positions", dict(collections.Counter(r["pos"] for r in out)), "vocabulary", len(words), "engines", dict(collections.Counter(eng)))


if __name__ == "__main__":
    main()
