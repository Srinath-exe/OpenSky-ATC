#!/usr/bin/env bash
# Build and redeploy the live site: next build -> copy static + public into the standalone bundle -> restart the
# openatc systemd service (127.0.0.1:3005 behind nginx).
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
rm -rf .next/standalone/.next/static .next/standalone/public
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
systemctl restart openatc
for i in $(seq 1 40); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3005/)" = 200 ] && { echo "live"; exit 0; }; sleep 0.5; done
echo "server did not come up"; systemctl status openatc --no-pager | tail -20; exit 1
