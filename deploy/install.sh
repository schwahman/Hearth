#!/usr/bin/env bash
# Hearth installer for a fresh Ubuntu 24.04 server.
#
# Use it as a Vultr "Startup Script" (or run it once as root). It:
#   1. installs Node.js 22 from nodejs.org
#   2. creates a locked-down "hearth" system user
#   3. clones the private GitHub repo with a read-only token
#   4. runs Hearth as a service on port 80, restarting if it crashes
#   5. opens ports 80/443 in the firewall
#   6. checks GitHub every 2 minutes and redeploys automatically when the
#      code changes, so updates go live without anyone logging in
#
# Paste your read-only GitHub token below before using it.
set -euo pipefail
export HOME=/root

GITHUB_REPO="schwahman/hearth"
GITHUB_TOKEN="PASTE_READ_ONLY_TOKEN_HERE"

APP_DIR=/opt/hearth
DATA_DIR=/var/lib/hearth
LOG=/var/log/hearth-install.log
exec > >(tee -a "$LOG") 2>&1
echo "=== Hearth install started $(date) ==="

if [[ "$GITHUB_TOKEN" == PASTE_* ]]; then
  echo "ERROR: put your GitHub token in GITHUB_TOKEN first." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl xz-utils ca-certificates ufw

# ---- Node.js 22 (official build) ----
if ! command -v node >/dev/null || [[ "$(node -v)" != v22.* ]]; then
  base=https://nodejs.org/dist/latest-v22.x
  file=$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-x64.tar.xz$/ {print $2}')
  curl -fsSL "$base/$file" -o "/tmp/$file"
  (cd /tmp && curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | sha256sum -c -)
  tar -xJf "/tmp/$file" -C /usr/local --strip-components=1
  rm -f "/tmp/$file"
fi
node -v

# ---- user and folders ----
id hearth >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin hearth
mkdir -p "$DATA_DIR"
chown hearth:hearth "$DATA_DIR"
chmod 700 "$DATA_DIR"

# ---- code ----
# The token is stored only in root's git credentials file (mode 600).
git config --global credential.helper store
printf 'https://x-access-token:%s@github.com\n' "$GITHUB_TOKEN" > /root/.git-credentials
chmod 600 /root/.git-credentials
git config --global --add safe.directory "$APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch origin main && git -C "$APP_DIR" reset --hard origin/main
else
  git clone --branch main "https://github.com/$GITHUB_REPO.git" "$APP_DIR"
fi
chown -R root:root "$APP_DIR"

# ---- settings (edit /etc/hearth.env later to change anything) ----
if [[ ! -f /etc/hearth.env ]]; then
  cat > /etc/hearth.env <<EOF
PORT=80
HOST=0.0.0.0
DATA_DIR=$DATA_DIR
MAX_UPLOAD_MB=25
OPEN_REGISTRATION=true
EOF
fi

# ---- service ----
cp "$APP_DIR/deploy/hearth.service" /etc/systemd/system/hearth.service
cp "$APP_DIR/deploy/hearth-update.service" /etc/systemd/system/hearth-update.service
cp "$APP_DIR/deploy/hearth-update.timer" /etc/systemd/system/hearth-update.timer
install -m 755 "$APP_DIR/deploy/update.sh" /usr/local/sbin/hearth-update
systemctl daemon-reload
systemctl enable --now hearth.service
systemctl enable --now hearth-update.timer

# ---- firewall ----
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

ip=$(curl -fsS -4 https://ifconfig.me || hostname -I | awk '{print $1}')
echo "=== Hearth is running: http://$ip ==="
