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

# Emergency admin tool for the server console: `hearth-admin help`
cat > /usr/local/sbin/hearth-admin <<'TOOL'
#!/usr/bin/env bash
# Runs Hearth's admin tool as the hearth user with the server's settings.
if [[ $EUID -ne 0 ]]; then echo "Run as root (or with sudo)." >&2; exit 1; fi
set -a; . /etc/hearth.env; set +a
exec runuser -u hearth -- env DATA_DIR="$DATA_DIR" /usr/local/bin/node --no-warnings /opt/hearth/server/cli.js "$@"
TOOL
chmod 755 /usr/local/sbin/hearth-admin

# Install log is not needed after setup; it may contain the GitHub token.
rm -f /var/log/hearth-install.log
exit 0
