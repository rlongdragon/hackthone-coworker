#!/usr/bin/env bash
# Supervise the telegram worker: restart on any exit (crash, silent SIGKILL).
# Usage: setsid ./scripts/telegram-worker.sh >> /path/to/tg-worker.log 2>&1 &
set -u
cd "$(dirname "$0")/../web"
while true; do
  echo "[supervisor] starting worker $(date -Is)"
  npm run worker:telegram
  code=$?
  echo "[supervisor] worker exited code=$code $(date -Is); restarting in 3s"
  sleep 3
done
