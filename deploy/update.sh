#!/usr/bin/env bash
# Pulls the latest code from GitHub and restarts Hearth if anything changed.
# Run every 2 minutes by hearth-update.timer.
set -euo pipefail
export HOME=/root
APP_DIR=/opt/hearth
cd "$APP_DIR"
git fetch --quiet origin main
if [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]]; then
  exit 0
fi
echo "Updating $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
git reset --hard --quiet origin/main
# Pick up changes to the service files themselves.
cp deploy/hearth.service /etc/systemd/system/hearth.service
cp deploy/hearth-update.service /etc/systemd/system/hearth-update.service
cp deploy/hearth-update.timer /etc/systemd/system/hearth-update.timer
install -m 755 deploy/update.sh /usr/local/sbin/hearth-update
systemctl daemon-reload
systemctl restart hearth.service
echo "Restarted on $(git log -1 --format='%h %s')"
