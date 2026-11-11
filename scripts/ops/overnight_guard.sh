#!/usr/bin/env bash
# Unattended-night guard (runs as systemd unit atc-guard): keeps the disk from filling and the site up.
#  - free disk on / below 10 GB: warn; below 6 GB: delete regenerable files (command-model candidates and snapshots,
#    scratch outputs, journal); below 3 GB: stop ML jobs (training, synthesis, scoring) so the server never fills up.
#  - the site (127.0.0.1:3005) failing 3 checks in a row while no build is running: systemctl restart openatc.
# Log: /var/log/atc-guard.log. Stop: systemctl stop atc-guard.
LOG=/var/log/atc-guard.log
SCRATCH=/tmp/claude-0/-root-atc/fa3a93e9-08da-451c-86ae-c9816b78a7de/scratchpad
fails=0
say() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
say "guard started"
while true; do
  free_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
  if [ "$free_gb" -lt 10 ]; then say "disk low: ${free_gb} GB free"; fi
  if [ "$free_gb" -lt 6 ]; then
    rm -rf /root/atc/public/models/s1-cand /root/atc/.next/standalone/public/models/s1-cand
    find /root/atc/ml/rl/runs -maxdepth 1 -type d -name '*-s[0-9]*' -exec rm -rf {} + 2>/dev/null
    rm -rf "$SCRATCH"/edge/br_* "$SCRATCH"/sp "$SCRATCH"/synth* /root/atc/.tmp/selfplay 2>/dev/null
    journalctl --vacuum-size=200M >/dev/null 2>&1
    say "cleanup done: $(df -BG --output=avail / | tail -1 | tr -dc 0-9) GB free"
  fi
  if [ "$(df -BG --output=avail / | tail -1 | tr -dc 0-9)" -lt 3 ]; then
    pkill -f 'ml/rl/(sft|grpo)\.py|sft\.py --|grpo\.py --|ml/stt/data/synth|freeword/watch\.py|kokoro' && say "disk critical: ML jobs stopped"
  fi
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' http://127.0.0.1:3005/ || echo 000)
  if [ "$code" = 200 ]; then fails=0; else
    if ps -eo args | grep -q '^node .*next build\|^bash scripts/deploy.sh'; then fails=0; else fails=$((fails+1)); say "site check failed ($code), $fails in a row"; fi
    if [ "$fails" -ge 3 ]; then systemctl restart openatc; say "openatc restarted"; fails=0; sleep 60; fi
  fi
  sleep 60
done
