#!/usr/bin/env bash
# Problem reports and crashes from the live site (/api/report). Usage: scripts/reports.sh [days=1] [r|e]
cd "$(dirname "$0")/.."; DAYS=${1:-1}; KIND=${2:-}
ls data/reports/*.jsonl 2>/dev/null | tail -n "$DAYS" | xargs -r cat | node -e '
const kind = process.argv[1]; const browser = (ua) => { const m = ua.match(/(Edg|Firefox|CriOS|Chrome)\/(\d+)/) || ua.match(/Version\/(\d+).*Safari/); return (m ? (m[2] ? m[1] + " " + m[2] : "Safari " + m[1]) : "?") + (/Mobile|Android|iPhone/.test(ua) ? " (phone)" : ""); }; const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean).map(JSON.parse);
for (const r of lines) { if (kind && !r.id.startsWith(kind)) continue;
  console.log(`\n== ${r.id} ${r.at} ${r.url} ${r.screen} ${browser(r.ua || "")}`);
  if (r.note) console.log("NOTE:", r.note); if (r.message) console.log("ERROR:", r.message, "\n", (r.stack || "").split("\n").slice(0, 4).join("\n "));
  for (const s of r.speech || []) console.log(`  heard[${s.engine}] "${s.heard ?? ""}" -> ${s.line ?? "-"} ${s.ok ? "ok" : ""}${s.sayAgain ? " say-again" : ""}`);
  for (const l of (r.radio || []).slice(-8)) console.log(`  ${l.who}: ${l.text}`);
}' "$KIND"
