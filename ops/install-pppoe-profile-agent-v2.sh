#!/usr/bin/env bash
set -euo pipefail

BASE="https://raw.githubusercontent.com/TechGeek-PH/Database/main/ops"
APP_DIR="/opt/techgeekph/pppoe-profile-agent-v2"
ENV_DIR="/etc/techgeekph"
ENV_FILE="$ENV_DIR/pppoe-agent.env"
SERVICE="techgeekph-pppoe-profile-agent-v2.service"

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "Run as root: sudo bash $0"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y python3 python3-venv curl ca-certificates >/dev/null

mkdir -p "$APP_DIR" "$ENV_DIR"

# Reuse existing secrets without printing them. Prefer the canonical env file; if it
# does not exist, locate an existing TechGeekPH env file that already contains both
# Supabase and MikroTik credentials and symlink it into place.
if [ ! -f "$ENV_FILE" ]; then
  found=""
  while IFS= read -r candidate; do
    [ -f "$candidate" ] || continue
    if grep -Eq '^(SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY)=' "$candidate" \
       && grep -Eq '^(SUPABASE_URL)=' "$candidate" \
       && grep -Eq '^(MIKROTIK_USER|MIKROTIK_USERNAME|MIKROTIK_API_USER)=' "$candidate" \
       && grep -Eq '^(MIKROTIK_PASSWORD|MIKROTIK_API_PASSWORD)=' "$candidate"; then
      found="$candidate"
      break
    fi
  done < <(find /etc/techgeekph /opt/techgeekph -maxdepth 4 -type f \( -name '*.env' -o -name '*.conf' -o -name 'environment' \) 2>/dev/null | sort)

  if [ -z "$found" ]; then
    echo "ERROR: Could not find an existing TechGeekPH env file containing Supabase + MikroTik credentials."
    echo "Expected canonical path: $ENV_FILE"
    exit 2
  fi
  ln -s "$found" "$ENV_FILE"
fi

chmod 600 "$(readlink -f "$ENV_FILE")" || true

curl -fsSL "$BASE/pppoe-profile-agent-v2.py" -o "$APP_DIR/pppoe-profile-agent-v2.py"
curl -fsSL "$BASE/requirements-pppoe-profile-agent-v2.txt" -o "$APP_DIR/requirements.txt"
curl -fsSL "$BASE/techgeekph-pppoe-profile-agent-v2.service" -o "/etc/systemd/system/$SERVICE"
chmod 755 "$APP_DIR/pppoe-profile-agent-v2.py"

if [ ! -x "$APP_DIR/.venv/bin/python" ]; then
  python3 -m venv "$APP_DIR/.venv"
fi
"$APP_DIR/.venv/bin/pip" install --upgrade pip >/dev/null
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt" >/dev/null

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
sleep 4

if ! systemctl is-active --quiet "$SERVICE"; then
  echo "ERROR: $SERVICE is not active. Recent logs:"
  journalctl -u "$SERVICE" -n 60 --no-pager
  exit 3
fi

echo "OK: $SERVICE is active."
echo "Recent agent logs:"
journalctl -u "$SERVICE" -n 30 --no-pager
