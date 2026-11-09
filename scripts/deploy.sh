#!/usr/bin/env bash
# Build and redeploy the live site: next build -> copy static + public into the standalone bundle -> restart the
# openatc systemd service (127.0.0.1:3005 behind nginx).
set -euo pipefail
cd "$(dirname "$0")/.."
# The bundler walks ml/ (the gold-set route reads ml/data/gold at run time) and panics on a relative symlink that leads
# out of the repo, which every new Python venv has (bin/python -> python3 -> /usr/bin/python3): point those straight at
# their absolute target first (same file, the venv still works)
find ml -path '*/.*' -prune -o -type l ! -lname '/*' -print 2>/dev/null | while read -r l; do
  t=$(readlink -f "$l") || continue
  case "$t" in "$PWD"/*|"") ;; *) ln -sfn "$t" "$l" && echo "deploy: symlink $l -> $t (absolute)";; esac
done
npm run build    # prebuild compiles the browser voice engine (scripts/build-voice.sh)
rm -rf .next/standalone/.next/static .next/standalone/public
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
systemctl restart openatc
for i in $(seq 1 40); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3005/)" = 200 ] && { echo "live"; exit 0; }; sleep 0.5; done
echo "server did not come up"; systemctl status openatc --no-pager | tail -20; exit 1
