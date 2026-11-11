"""A spec in Markdown -> a report page in the reports' house style (headings, paragraphs, lists, tables, code blocks).
    python3 ml/report/md_report.py docs/spec/13-PILOT-BRAIN.md public/reports/pilot-brain.html "Pilot Brain" "plan" """
import html, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def inline(t):
    t = html.escape(t)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    return re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", re.sub(r"(?<!\*)\*([^*\s][^*]*)\*(?!\*)", r"<i>\1</i>", t))


def convert(md):
    out, lines, i, title = [], md.split("\n"), 0, ""
    is_item = lambda x: x.startswith("- ") or re.match(r"^\d+\. ", x)
    while i < len(lines):
        l = lines[i]
        if l.startswith("# "): title = l[2:]; i += 1; continue
        if l.startswith("## "):
            if out: out.append("</section>")
            out += ['<section class="card">', f"<h2>{inline(l[3:])}</h2>"]; i += 1; continue
        if l.startswith("```"):
            i += 1; code = []
            while i < len(lines) and not lines[i].startswith("```"): code.append(lines[i]); i += 1
            out.append('<pre class="code">' + html.escape("\n".join(code)) + "</pre>"); i += 1; continue
        if l.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"): rows.append(lines[i]); i += 1
            cells = lambda r: [c.strip() for c in r.strip().strip("|").split("|")]
            out.append('<div class="scroll"><table><thead><tr>' + "".join(f"<th>{inline(c)}</th>" for c in cells(rows[0])) + "</tr></thead><tbody>"
                       + "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in cells(r)) + "</tr>" for r in rows[2:]) + "</tbody></table></div>"); continue
        if is_item(l):
            tag = "ol" if re.match(r"^\d+\. ", l) else "ul"; items = []
            while i < len(lines) and (is_item(lines[i]) or (lines[i].startswith("  ") and items)):
                x = lines[i]
                if x.startswith("  "): items[-1] += " " + x.strip()
                else: items.append(re.sub(r"^(- |\d+\. )", "", x))
                i += 1
            out.append(f"<{tag}>" + "".join(f"<li>{inline(t)}</li>" for t in items) + f"</{tag}>"); continue
        if not l.strip(): i += 1; continue
        para = []
        while i < len(lines) and lines[i].strip() and not lines[i].startswith(("#", "|", "```")) and not is_item(lines[i]): para.append(lines[i]); i += 1
        out.append(f"<p>{inline(' '.join(para))}</p>")
    out.append("</section>")
    body = "\n".join(out); k = body.find("<section")
    return title, body[:k], body[k:]


def main():
    src, dst, short, pill = sys.argv[1], sys.argv[2], sys.argv[3], (sys.argv[4] if len(sys.argv) > 4 else "plan")
    ref = (ROOT / "public/reports/voice-stt-finetune.html").read_text()
    style = ref[ref.index("<style>"):ref.index("</style>") + 8]
    title, intro, rest = convert(Path(src).read_text())
    page = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex">
<title>{html.escape(short)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap">
{style}
<style>ol,ul{{margin:0 0 10px;padding-left:22px}} li{{margin-bottom:6px}} section.card p:last-child{{margin-bottom:0}}
pre.code{{font-family:var(--mono);font-size:12px;line-height:1.35;background:var(--raise);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;color:var(--ink-1)}}</style>
</head><body><div class="wrap">
<header><p class="cap"><a href="/reports/">Reports</a> · {html.escape(pill)} · source <code>{html.escape(str(Path(src)))}</code></p>
<h1>{html.escape(title)}</h1>{intro}</header>
{rest}
</div></body></html>'''
    Path(dst).write_text(page); print(dst, len(page))


if __name__ == "__main__":
    main()
