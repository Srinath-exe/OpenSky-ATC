"""Extra speech-recogniser-style noise on top of a training transcript (for mining noisy hard prompts).

Modelled on the errors the real recognisers make in the GPU bake-off (ml/gpu/results/stt), without training on those
transcripts: digit runs split or glued ("2. 7-3" for 273, "1-3,000"), "niner" heard as "9 or", homophones, misspelt
long words ("expertite"), compound airline names split ("speed bird"), letters spelt out ("k l m"), phonetic letters
misspelt, a dropped or repeated short word. 1-3 edits per transcript; the label stays the same.
"""
import random, re

HOMO = {"four": ["for"], "two": ["to", "too"], "eight": ["ate"], "one": ["won"], "to": ["two"], "for": ["four"], "right": ["write"],
        "five": ["fife"], "three": ["tree"], "nine": ["nine er", "9 or", "niner"]}
SPLIT_NAMES = {"speedbird": "speed bird", "jetblue": "jet blue", "southwest": "south west", "fedex": "fed ex", "skywest": "sky west", "jetstar": "jet star",
               "lufthansa": "lufthanza", "emirates": "emirate", "qantas": "quantas", "klm": "k l m", "ups": "u p s", "easy": "easyjet", "ryanair": "ryan air",
               "shamrock": "sham rock", "scooter": "scoot", "virgin": "virgin atlantic", "delta": "delta airlines", "united": "united airlines"}
PHON = {"alpha": "alfa", "bravo": "brava", "charlie": "charley", "juliett": "juliet", "kilo": "keylo", "lima": "leema", "papa": "poppa", "sierra": "siera",
        "whiskey": "whisky", "xray": "x ray", "yankee": "yanky", "foxtrot": "fox trot", "november": "novembre", "golf": "gulf", "hotel": "hotell", "oscar": "oskar"}
SHORT = {"to", "the", "and", "of", "for", "via", "at", "on", "then", "please", "uh", "um"}
KEEP = {"left", "right", "center", "not", "no", "hold", "short", "cleared", "cross", "climb", "descend", "land", "takeoff", "around", "cancel", "unable", "behind",
        "heading", "speed", "contact", "taxi", "expect", "direct", "squawk"}


def _typo(w, rng):
    i = rng.randrange(1, len(w) - 1)
    op = rng.random()
    if op < 0.4:
        return w[:i] + rng.choice("aeioutrsnl") + w[i + 1:]
    if op < 0.7:
        return w[:i] + w[i + 1:]
    return w[:i] + rng.choice("aeioutrsnl") + w[i:]


def noisy(said: str, rng: random.Random, n_ops=None) -> str:
    w = said.split()
    if not w:
        return said
    for _ in range(n_ops or rng.choice([1, 1, 2, 2, 3])):
        if not w:
            break
        op = rng.random(); i = rng.randrange(len(w)); x = w[i]
        if op < 0.25:                                            # digit run split or a thousand written out
            cands = [j for j, t in enumerate(w) if t.isdigit() and len(t) >= 2]
            if cands:
                j = rng.choice(cands); t = w[j]
                if t.endswith("000") and len(t) >= 4 and rng.random() < 0.5:
                    w[j:j + 1] = [" ".join(t[:-3]), "000"] if rng.random() < 0.5 else [t[:-3], "thousand"]
                else:
                    k = rng.randrange(1, len(t)); w[j:j + 1] = [t[:k], t[k:]]
                w = " ".join(w).split()
        elif op < 0.40:                                          # homophones / niner
            cands = [j for j, t in enumerate(w) if t in HOMO]
            if cands:
                j = rng.choice(cands); w[j] = rng.choice(HOMO[w[j]]); w = " ".join(w).split()
        elif op < 0.55:                                          # airline name mis-segmented / phonetic letter misspelt
            cands = [j for j, t in enumerate(w) if t in SPLIT_NAMES or t in PHON]
            if cands:
                j = rng.choice(cands); w[j] = SPLIT_NAMES.get(w[j]) or PHON[w[j]]; w = " ".join(w).split()
        elif op < 0.75:                                          # misspelt long word (not a number, not a meaning word)
            cands = [j for j, t in enumerate(w) if len(t) >= 6 and t.isalpha() and t not in KEEP]
            if cands:
                j = rng.choice(cands); w[j] = _typo(w[j], rng)
        elif op < 0.87:                                          # dropped short word
            cands = [j for j, t in enumerate(w) if t in SHORT]
            if cands:
                del w[rng.choice(cands)]
        else:                                                    # repeated word / restart
            if rng.random() < 0.5:
                w.insert(i, x)
            else:
                k = min(len(w), rng.randint(1, 3)); w = w[:k] + w
    return re.sub(r"\s+", " ", " ".join(w)).strip()
