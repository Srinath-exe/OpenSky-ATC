"""One transcript style for every speech-to-text training source (synthetic and public corpora), ml/stt/DATA.md:
lower case, words only, numbers as spoken words ("two seven left", "eight sixty five"), ICAO variants folded
(tree -> three, fife -> five, niner -> nine, fower -> four), digits written in a corpus spelled digit by digit."""
import re

ICAO = {"tree": "three", "fife": "five", "niner": "nine", "fower": "four", "tousand": "thousand", "hundert": "hundred",
        # one spelling per word across corpora (UWB / ATCO2 write alfa, juliet, centre)
        "alfa": "alpha", "juliet": "juliett", "whisky": "whiskey", "centre": "center", "x-ray": "xray"}
DIG = "zero one two three four five six seven eight nine".split()


def norm(text: str) -> str:
    s = text.lower().replace("’", "'")
    s = re.sub(r"(\d)\.(\d)", r"\1 decimal \2", s)
    s = re.sub(r"\d", lambda m: f" {DIG[int(m.group())]} ", s)
    s = re.sub(r"[-_/]", " ", s)
    s = re.sub(r"[^a-z' ]", " ", s)
    s = re.sub(r"(^| )'+|'+( |$)", " ", s)
    return " ".join(ICAO.get(w, w) for w in s.split())
