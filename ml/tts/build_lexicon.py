"""The browser's pronunciation lexicon (public/models/tts/atc-lexicon-v1.json): misaki's own phonemes for the game's
vocabulary, American and British, so the browser reads what Paradee was trained on without running misaki (Python).
Words outside it fall back to eSpeak NG + paradee's eSpeak-to-misaki table (public/voice/tts-g2p.js).

    ml/stt/.venv/bin/python ml/tts/build_lexicon.py                   # full lexicon -> public/models/tts/atc-lexicon-v1.json
    ml/stt/.venv/bin/python ml/tts/build_lexicon.py --exclude-bench   # without the 60 benchmark lines -> ml/tts/out/lexicon_eval.json

Vocabulary: every exported pilot line (ml/tts/data/lines_all.jsonl, read in context: the most frequent phonemes per word),
the words in the engine's string literals (src/lib/sim/*.ts: phraseology, messages, airport names), the twelve
airspace files' fixes with their spoken names (public/airspace/*.txt: "BIG ... bigg-in" -> "BIG" says "biggin"), and the
letter names for spelling codes ("JFKSE").
"""
import argparse, json, re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORD = re.compile(r"^[A-Za-z][A-Za-z'\-]*$")


def word_like(code):
    """Same rule as src/lib/tts/pilotSpeech.ts wordLike(): codes the normaliser lowercases."""
    if not (4 <= len(code) <= 6) or not re.search(r"[AEIOU]", code) or re.search(r"[^AEIOU]{3}", code):
        return False
    return not re.fullmatch(r"[A-Z]{3}(N|S|E|W|NE|NW|SE|SW|NO|SO|EA|WE)", code)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--exclude-bench", action="store_true")
    a = ap.parse_args()
    from misaki import en, espeak
    g2p = {acc: en.G2P(trf=False, british=acc == "gb", fallback=espeak.EspeakFallback(british=acc == "gb"), unk="") for acc in ("us", "gb")}
    bench = {json.loads(l)["text"] for l in open(ROOT / "ml/tts/data/bench60.jsonl")} if a.exclude_bench else set()
    texts = [json.loads(l)["spoken"] for l in open(ROOT / "ml/tts/data/lines_all.jsonl") if json.loads(l)["text"] not in bench]
    # words in the engine's string literals
    words = set()
    for f in sorted((ROOT / "src/lib/sim").glob("*.ts")) + [ROOT / "src/components/atc/simStore.ts"]:
        src = f.read_text()
        for lit in re.findall(r"'([^'\n]{2,200})'|`([^`\n]{2,300})`", src):
            for w in re.findall(r"[A-Za-z][a-z]+(?:-[a-z]+)?", (lit[0] or lit[1]).replace("${", " ")):
                words.add(w)
    # fixes and their spoken names
    fixes = {}
    for f in sorted((ROOT / "public/airspace").glob("*.txt")):
        sec = None
        for line in f.read_text(errors="ignore").splitlines():
            if re.match(r"^\w+ =\s*$", line):
                sec = line.split("=")[0].strip(); continue
            if sec == "beacons" and line.startswith("\t"):
                p = [x.strip() for x in line.split(",")]
                if len(p) >= 5 and re.fullmatch(r"[A-Z]{2,5}", p[0]) and p[4]:
                    fixes.setdefault(p[0], p[4])
            m = re.match(r"^name = (.+)$", line)
            if m:
                for w in re.findall(r"[A-Za-z]+", m.group(1)):
                    words.add(w.capitalize())
    lex = {}
    for acc, g in g2p.items():
        votes = defaultdict(Counter)
        for t in texts:
            for tok in g(t)[1]:
                if WORD.match(tok.text) and tok.phonemes:
                    votes[tok.text][tok.phonemes] += 1
        for w in sorted(words):
            if w not in votes:
                ps = g(w)[0]
                if ps:
                    votes[w][ps] += 1
        d = {w: c.most_common(1)[0][0] for w, c in votes.items()}
        # lower-case keys for capitalised words whose lower case is missing (the browser looks up exact, then lower)
        for w in list(d):
            if w[0].isupper() and w.lower() not in d and not w.isupper():
                d[w.lower()] = d[w]
        # fixes: the code says its spoken name
        for code, said in fixes.items():
            ps = g(said.replace("-", ""))[0]
            if not ps:
                continue
            d[code] = ps
            if word_like(code):
                d[code.lower()] = ps
        letters = {}
        for L in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            letters[L] = "ˈA" if L == "A" else g(L)[0]
        lex[acc] = {"words": dict(sorted(d.items())), "letters": letters,
                    "the": {"vowel": g("the end")[0].split()[0], "consonant": g("the runway")[0].split()[0]}}
    out = {"v": 1, "source": "misaki 0.9.4 (hexgrad, Apache-2.0) phonemes for OpenATC's vocabulary; ml/tts/build_lexicon.py",
           "us": lex["us"], "gb": lex["gb"]}
    path = ROOT / ("ml/tts/out/lexicon_eval.json" if a.exclude_bench else "public/models/tts/atc-lexicon-v1.json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"{path}: us {len(lex['us']['words'])} words, gb {len(lex['gb']['words'])}, fixes {len(fixes)}, {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
