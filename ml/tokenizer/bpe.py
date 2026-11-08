"""Byte-level BPE tokenizer, from scratch (ml/README.md module 2).

How it works, in four steps:
  1. Pre-tokenize: split text into chunks with a regex (a word with its leading space, a punctuation run, a newline).
     Merges never cross a chunk boundary, so " heading" and " 270" are learned separately.
  2. Start from bytes: every chunk is a sequence of UTF-8 byte ids 0-255, so ANY text can be encoded (no unknown token).
  3. Train: count every adjacent pair of ids over the corpus (weighted by chunk frequency), merge the most frequent
     pair into a new id, repeat until the vocabulary is full. The ordered merge list IS the tokenizer.
  4. Encode: apply the merges to a new chunk in the order they were learned (lowest rank first).

Special tokens mark the parts of a training example: <ctx> game state <said> transcript <cmd> command line <eos>.

    python3 ml/tokenizer/bpe.py train ml/data/out/ds/train.jsonl --vocab 2048 --out ml/tokenizer/atc.json
    python3 ml/tokenizer/bpe.py stats ml/tokenizer/atc.json ml/data/out/ds/val.jsonl
"""
import argparse, collections, json, re, sys, time

SPECIALS = ["<pad>", "<bos>", "<eos>", "<ctx>", "<said>", "<cmd>"]
# Each digit is its own chunk (as in Llama and Qwen): "270" is always "2" "7" "0", so the model reads and copies any
# number digit by digit. Letting BPE merge "270" into one token would make every heading a separate, rare symbol.
PRETOK = re.compile(r"\n| ?[A-Za-z]+| ?\d| ?[^\sA-Za-z\d]+|\s+(?!\S)|\s+")


def chunks(text: str) -> list[str]:
    return PRETOK.findall(text)


def example_text(ex: dict) -> str:
    return f"<ctx>{ex['ctx']}<said> {ex['said']}<cmd> {ex['line']}<eos>"


class BPE:
    def __init__(self, merges: list[tuple[int, int]]):
        self.merges = merges
        self.rank = {pair: i for i, pair in enumerate(merges)}
        self.special = {s: 256 + i for i, s in enumerate(SPECIALS)}
        self.base = 256 + len(SPECIALS)
        self.vocab: dict[int, bytes] = {i: bytes([i]) for i in range(256)}
        for s, i in self.special.items():
            self.vocab[i] = s.encode()
        for i, (a, b) in enumerate(merges):
            self.vocab[self.base + i] = self.vocab[a] + self.vocab[b]
        self.cache: dict[str, list[int]] = {}

    @property
    def size(self) -> int:
        return self.base + len(self.merges)

    def _encode_chunk(self, chunk: str) -> list[int]:
        if chunk in self.cache:
            return self.cache[chunk]
        ids = list(chunk.encode())
        while len(ids) > 1:
            # the pair with the lowest merge rank goes first, exactly like training order
            best = min(((self.rank.get((ids[i], ids[i + 1]), 1 << 30), i) for i in range(len(ids) - 1)))
            if best[0] == 1 << 30:
                break
            r, i = best
            ids = ids[:i] + [self.base + r] + ids[i + 2:]
        self.cache[chunk] = ids
        return ids

    def encode(self, text: str) -> list[int]:
        out: list[int] = []
        for part in re.split(r"(<pad>|<bos>|<eos>|<ctx>|<said>|<cmd>)", text):
            if part in self.special:
                out.append(self.special[part])
            elif part:
                for c in chunks(part):
                    out.extend(self._encode_chunk(c))
        return out

    def decode(self, ids: list[int]) -> str:
        return b"".join(self.vocab[i] for i in ids).decode("utf-8", errors="replace")

    def save(self, path: str):
        json.dump({"specials": SPECIALS, "merges": self.merges}, open(path, "w"))

    @staticmethod
    def load(path: str) -> "BPE":
        d = json.load(open(path))
        assert d["specials"] == SPECIALS
        return BPE([tuple(m) for m in d["merges"]])


def train(texts, vocab_size: int, verbose=True) -> BPE:
    t0 = time.time()
    freq: collections.Counter = collections.Counter()
    for t in texts:
        for part in re.split(r"<pad>|<bos>|<eos>|<ctx>|<said>|<cmd>", t):
            freq.update(chunks(part))
    words = [(list(w.encode()), n) for w, n in freq.items()]
    base = 256 + len(SPECIALS)
    merges: list[tuple[int, int]] = []
    while base + len(merges) < vocab_size:
        pairs: collections.Counter = collections.Counter()
        for ids, n in words:
            for i in range(len(ids) - 1):
                pairs[(ids[i], ids[i + 1])] += n
        if not pairs:
            break
        (a, b), count = pairs.most_common(1)[0]
        if count < 2:
            break
        new = base + len(merges)
        merges.append((a, b))
        for ids, _ in words:                       # apply the merge in place
            i = 0
            while i < len(ids) - 1:
                if ids[i] == a and ids[i + 1] == b:
                    ids[i:i + 2] = [new]
                i += 1
        if verbose and len(merges) % 250 == 0:
            tok = BPE(merges)
            print(f"  {len(merges)} merges ({time.time() - t0:.0f}s) last: {tok.vocab[new]!r} x{count}", file=sys.stderr)
    if verbose:
        print(f"trained {len(merges)} merges on {len(freq)} unique chunks in {time.time() - t0:.1f}s", file=sys.stderr)
    return BPE(merges)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train"); t.add_argument("data"); t.add_argument("--vocab", type=int, default=2048); t.add_argument("--out", required=True); t.add_argument("--max", type=int, default=200000)
    s = sub.add_parser("stats"); s.add_argument("tok"); s.add_argument("data"); s.add_argument("--max", type=int, default=5000)
    a = ap.parse_args()
    if a.cmd == "train":
        texts = []
        for i, line in enumerate(open(a.data)):
            if i >= a.max:
                break
            texts.append(example_text(json.loads(line)))
        tok = train(texts, a.vocab)
        tok.save(a.out)
        print(json.dumps({"vocab": tok.size, "merges": len(tok.merges), "out": a.out}))
    else:
        tok = BPE.load(a.tok)
        n = {"ctx": 0, "said": 0, "line": 0, "bytes": 0, "rows": 0}
        for i, line in enumerate(open(a.data)):
            if i >= a.max:
                break
            ex = json.loads(line)
            n["ctx"] += len(tok.encode(ex["ctx"])); n["said"] += len(tok.encode(" " + ex["said"])); n["line"] += len(tok.encode(" " + ex["line"]))
            n["bytes"] += len(example_text(ex).encode()); n["rows"] += 1
            assert tok.decode(tok.encode(example_text(ex))) == example_text(ex), "round trip"
        r = n["rows"]
        total = n["ctx"] + n["said"] + n["line"]
        print(json.dumps({"vocab": tok.size, "rows": r, "tokens_per_example": round(total / r, 1), "ctx": round(n["ctx"] / r, 1), "said": round(n["said"] / r, 1), "line": round(n["line"] / r, 1), "bytes_per_token": round(n["bytes"] / total, 2)}))
        longest = sorted(tok.vocab.items(), key=lambda kv: -len(kv[1]))[:20]
        print("longest tokens:", [v.decode(errors="replace") for _, v in longest])


if __name__ == "__main__":
    main()
