#!/usr/bin/env bash
# Host-level settings, applied (as root) every time Hearth starts, so
# updates pulled from GitHub can adjust the server itself. Idempotent.
set -euo pipefail

# Keep system logs (which include Hearth's) for at most 30 days, matching
# the Privacy Policy.
conf=/etc/systemd/journald.conf.d/hearth-retention.conf
want=$'[Journal]\nMaxRetentionSec=30day\nSystemMaxUse=500M\n'
if [[ "$(cat "$conf" 2>/dev/null)" != "$want" ]]; then
  mkdir -p "$(dirname "$conf")"
  printf '%s' "$want" > "$conf"
  systemctl restart systemd-journald || true
fi

# Install log is not needed after setup; it may contain the GitHub token.
rm -f /var/log/hearth-install.log
exit 0
